import { LAYOUT } from "../lib/layout.mjs";
// CAPABILITIES — the tool's inventory of security-relevant filesystem and
// network capability classes. The manifest is
// worthless if it can drift into a comforting fiction, so these tests pin every
// clause to what the code ACTUALLY does — the write-path constants the writers
// use, the egress derived from the resolved config, and the promotion rule
// exercised against the real boundary in lib/promote.mjs.
//
//   node --test test/capabilities.test.mjs
//
// Written before the implementation (S1). The command and lib/capabilities.mjs
// do not exist yet: this suite fails on the missing import and the unknown
// subcommand until they do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capabilityManifest, renderCapabilities, POINTER_FILES, PROMOTION_RULE } from "../lib/capabilities.mjs";
import { promoteObservation } from "../lib/promote.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";
import { SUITE_DIR } from "../lib/suites.mjs";
import { BASELINE_FILE } from "../lib/ci.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const cli = (cwd, env, ...args) =>
  execFileSync("node", [CLI, ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });

// A sandbox git repo carrying a config the manifest must read back faithfully.
function sandbox(config) {
  const dir = mkdtempSync(join(tmpdir(), "capabilities-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"),
    "openapi: 3.0.0\ninfo:\n  title: t\npaths:\n  /json:\n    get:\n      summary: s\n");
  if (config) writeFileSync(join(dir, LAYOUT.environments), JSON.stringify(config));
  return dir;
}

// The controlled inputs the CLI would gather, so the builder is tested in
// isolation from config resolution and the heavy client import.
const inputs = (over = {}) => ({
  root: "/repo",
  config: { baseUrl: "http://127.0.0.1:8787", hosts: {}, ...over.config },
  evidence: "/repo/evidence",
  usageLog: join(homedir(), ".agent-api-poc", "usage.jsonl"),
  tokenCache: join(homedir(), ".agent-api-poc", "tokens"),
  tokenUrl: null,
  ...over,
});

const pathsOf = (m) => m.writes.map((w) => w.path);

test("R11 capabilities disclose in-place legacy reads and current-only writes", () => {
  const manifest = capabilityManifest(inputs());
  const state = manifest.reads.find(({ id }) => id === "local-state");
  assert.match(state.guard, /both usage logs/);
  assert.match(state.guard, /current.*legacy.*in place/);
  assert.match(state.guard, /linked.*never read/);
  const notice = manifest.writes.find(({ id }) => id === "legacy-state-notice");
  assert.ok(notice, "only the notice is written; no migration capability remains");
  assert.match(notice.guard, /never moved, renamed or deleted/);
  assert.equal(manifest.writes.some(({ id }) => id === "state-migration"), false);
});

// --- write paths: nothing fabricated, nothing omitted ----------------------

test("the manifest lists exactly the real committed write-paths", () => {
  const m = capabilityManifest(inputs());
  const paths = pathsOf(m);
  // Each writer's OWN constant must appear — a hardcoded string here would let
  // a rename drift the manifest into a lie.
  assert.ok(paths.includes(CONTEXT_FILE), "sannr.json (through the promotion boundary)");
  assert.ok(paths.some((p) => p.startsWith(`${SUITE_DIR}/`)), "saved suites");
  assert.ok(paths.includes(BASELINE_FILE), "the audit baseline");
  for (const f of POINTER_FILES)
    assert.ok(paths.includes(f), `the ${f} pointer block`);
});

test("sannr.json is flagged as passing the promotion boundary", () => {
  const w = capabilityManifest(inputs()).writes.find((w) => w.path === CONTEXT_FILE);
  assert.equal(w.committed, true);
  assert.match(w.guard, /promotion boundary/i);
});

test("host-native MCP registrations disclose committed machine-local regeneration", () => {
  const row = capabilityManifest(inputs()).writes.find(({ id }) => id === "mcp-registration");
  assert.ok(row);
  assert.equal(row.committed, true,
    "the host-defined project configs may already be Git-tracked and remain writable");
  assert.match(row.contains, /machine-local.*absolute|absolute.*machine-local/i);
  assert.match(row.guard, /host-native|host-defined/i);
  assert.match(row.guard, /teammates?.*re-run connect|re-run connect.*machine/i);
  assert.match(row.guard, /idempotent|correct/i);
});

test("committed skills disclose command-tier rendering rather than claiming verbatim copies", () => {
  const row = capabilityManifest(inputs()).writes.find(({ id }) => id === "skills");
  assert.ok(row);
  assert.match(row.guard, /tier-rendered|verified portable|non-command omission/i);
  assert.doesNotMatch(row.guard, /verbatim from the package/i);
});

test("evidence is declared as self-gitignored and never committed", () => {
  const w = capabilityManifest(inputs()).writes.find((w) => w.id === "evidence");
  assert.ok(w, "evidence directory must be declared — it holds complete response bodies");
  assert.equal(w.committed, false);
  assert.match(w.guard, /gitignore|self-ignor/i);
});

test("the usage log and token cache live outside the repo and carry no bodies", () => {
  const m = capabilityManifest(inputs());
  const usage = m.writes.find((w) => /usage/.test(w.path));
  const token = m.writes.find((w) => /token/.test(w.path));
  assert.ok(usage && token, "both client-side write paths must be declared");
  assert.equal(usage.committed, false);
  assert.equal(token.committed, false);
});

// save_to is a documented MCP tool parameter (client.mjs) that writes a binary
// response body to any caller-named absolute path via resolve(save_to) — outside
// evidence/, the repo, and every fixed path the manifest enumerates. The command
// exists to be a COMPLETE self-report of what it may write; the strictly-more-
// dangerous arbitrary-destination redirect cannot be the one path left unsaid.
test("the arbitrary save_to write destination is disclosed", () => {
  const m = capabilityManifest(inputs());
  const w = m.writes.find((entry) => entry.id === "save_to");
  assert.ok(w, "the save_to arbitrary write path must be declared");
  assert.equal(w.committed, false);
  assert.match(w.contains, /save_to/);
  // The human render must show it too.
  assert.match(renderCapabilities(m), /save_to/);
});

test("the arbitrary multipart upload read path is disclosed", () => {
  const m = capabilityManifest(inputs());
  const r = m.reads.find((entry) => entry.id === "upload-files");
  assert.ok(r, "the files parameter can read any local path and must be declared");
  assert.match(r.path, /caller|any/i);
  assert.match(r.contains, /multipart|upload/i);
  assert.match(renderCapabilities(m), /FILES \/ PATHS IT MAY READ[\s\S]*files MCP parameter/);
});

test("repository, env-file, local-state reads and caller-named map output are disclosed", () => {
  const m = capabilityManifest(inputs());
  for (const id of ["project-inputs", "configured-env-files", "local-state"])
    assert.ok(m.reads.some((entry) => entry.id === id), `${id} read class is missing`);
  const map = m.writes.find((entry) => entry.id === "map-output");
  assert.ok(map, "map writes a default or caller-selected HTML output path");
  assert.match(map.path, /api-footprint|--out/);
});

// --- egress: exactly the configured destinations, and nothing else ---------

test("AH-2 capabilities disclose the opt-in map preview as a loopback listener", () => {
  const manifest = capabilityManifest(inputs());
  const preview = manifest.listeners?.find(({ id }) => id === "map-preview");
  assert.ok(preview, "the preview's listening socket must be declared separately from egress");
  assert.equal(preview.address, "127.0.0.1");
  assert.equal(preview.protocol, "http");
  assert.equal(preview.port, "ephemeral");
  assert.match(preview.guard, /only.*--preview/);
  assert.match(preview.guard, /30 minutes/);
  assert.match(preview.guard, /pid.*stop command/i);
  const rendered = renderCapabilities(manifest);
  assert.match(rendered, /NETWORK LISTENERS/);
  assert.match(rendered, /127\.0\.0\.1.*ephemeral/);
  assert.match(rendered, /only.*--preview/);
});

test("egress lists configured destinations and the dynamic redirect class", () => {
  const m = capabilityManifest(inputs({
    config: { baseUrl: "https://api.example.com", hosts: {
      stripe: { baseUrl: "https://api.stripe.com" },
      clerk: { baseUrl: "https://api.clerk.com" } } },
    tokenUrl: "https://auth.example.com/token",
  }));
  assert.equal(m.egress.base_url, "https://api.example.com");
  assert.deepEqual(m.egress.hosts, { stripe: "https://api.stripe.com", clerk: "https://api.clerk.com" });
  // The global oauth token URL is a credential-egress destination.
  assert.deepEqual(m.egress.oauth_token_urls, ["https://auth.example.com/token"]);
  assert.match(m.egress.redirect_destinations, /redirect/i);
  assert.match(m.egress.note, /credentials.*dropped/i);
  // The manifest must not invent a destination beyond the egress classes.
  assert.deepEqual(new Set(Object.keys(m.egress)),
    new Set(["base_url", "hosts", "oauth_token_urls", "redirect_destinations", "note", "feedback"]));
});

test("with no OAuth configured no token URL is fabricated", () => {
  const m = capabilityManifest(inputs());
  assert.deepEqual(m.egress.oauth_token_urls, []);
});

// A host configured as oauth with its OWN tokenUrl POSTs client_id/client_secret
// to that endpoint (client.mjs applyAuth: auth.tokenUrl = ctx.tokenUrl). That is
// a credential-egress destination and the manifest — whose headline question is
// "where can it SEND bytes" — must name it, not claim none exists.
test("a per-host oauth tokenUrl is disclosed as a credential-egress destination", () => {
  const m = capabilityManifest(inputs({
    config: { baseUrl: "https://api.example.com", hosts: {
      vendorX: { baseUrl: "https://api.vendorx.com",
        auth: "oauth:VX_ID:VX_SECRET", tokenUrl: "https://auth.vendorx.com/oauth/token" } } },
    tokenUrl: null,   // no GLOBAL oauth — the only token endpoint is the host's own
  }));
  assert.ok(m.egress.oauth_token_urls.includes("https://auth.vendorx.com/oauth/token"),
    "the host's own token endpoint must appear in egress");
  // And the human render must show it, so a reader of the terminal block sees it too.
  const rendered = renderCapabilities(m);
  assert.match(rendered, /auth\.vendorx\.com\/oauth\/token/);
});

// The caller can explicitly supply an inherited token endpoint. Unlike a
// provider file's value, this really is available as a fallback to every host.
test("a supplied inherited oauth endpoint is disclosed once", () => {
  const m = capabilityManifest(inputs({
    config: { baseUrl: "https://api.example.com", hosts: {
      vendorY: { baseUrl: "https://api.vendory.com", auth: "oauth:VY_ID:VY_SECRET" } } },
    tokenUrl: "https://auth.global.com/token",
  }));
  assert.deepEqual(m.egress.oauth_token_urls, ["https://auth.global.com/token"]);
});

test('resolved OAuth destinations supersede stale global and config inputs', () => {
  const manifest = capabilityManifest(inputs({ tokenUrl: 'https://stale.example.test/token',
    oauthTokenUrls: [], config: { hosts: { removed: { auth: 'oauth:ID:SECRET', tokenUrl: 'https://removed.example.test/token' } } } }));
  assert.deepEqual(manifest.egress.oauth_token_urls, []);
});

test('CLI capability report scopes OAuth file endpoints to their providers', t => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const primary = join(dir, 'primary.env'), other = join(dir, 'other.env');
  writeFileSync(primary, 'CAP_FIXTURE_ID=synthetic-primary\nCAP_FIXTURE_SECRET=synthetic-secret\n');
  writeFileSync(other, 'CAP_FIXTURE_ID=synthetic-other\nCAP_FIXTURE_SECRET=synthetic-secret\nAPI_OAUTH_TOKEN_URL=https://other.example.test/token\n');
  const config = { default: 'local', environments: { local: { baseUrl: 'https://primary.example.test', auth: 'oauth:CAP_FIXTURE_ID:CAP_FIXTURE_SECRET', envFile: primary } }, hosts: { other: { baseUrl: 'https://other.example.test', auth: 'oauth:CAP_FIXTURE_ID:CAP_FIXTURE_SECRET', envFile: other } } };
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify(config));
  const env = { API_CONFIG: join(dir, LAYOUT.environments), API_ENV: 'local', API_OAUTH_TOKEN_URL: undefined, API_ENV_FILE: undefined, API_AUTH: undefined };
  const first = JSON.parse(cli(dir, env, 'capabilities', '--json'));
  assert.deepEqual(first.egress.oauth_token_urls, ['https://other.example.test/token']);
  const inherited = JSON.parse(cli(dir, { ...env, API_OAUTH_TOKEN_URL: 'https://inherited.example.test/token' }, 'capabilities', '--json'));
  assert.deepEqual(inherited.egress.oauth_token_urls, ['https://inherited.example.test/token']);
  assert.equal(JSON.stringify(first).includes('synthetic-secret'), false);
});

// --- promotion rule: the words match the boundary --------------------------

test("PROMOTION_RULE describes the three clauses the boundary actually enforces", () => {
  const contract = { type: "object", properties: {
    status: { type: "string", enum: ["active", "churned"] },   // declared enum
    owner: { type: "string" },                                 // open field
  } };
  const observed = { fieldValues: { status: ["active", "churned"], owner: ["alice", "bob"] } };

  // structure always
  const dev = promoteObservation({ operation: "GET /x", observed, contract, environment: { production: false } });
  assert.equal(dev.promoted.fields.status.distinct, 2, "cardinality is always promoted");
  // values only from a declared enum
  assert.deepEqual([...dev.promoted.fields.status.values].sort(), ["active", "churned"]);
  assert.equal(dev.promoted.fields.owner.values, undefined, "an open field never promotes values");
  // production promotes nothing
  const prod = promoteObservation({ operation: "GET /x", observed, contract, environment: { production: true } });
  assert.equal(prod.promoted.fields.status.values, undefined, "production promotes no values at all");

  // and the manifest's words say exactly that
  assert.match(PROMOTION_RULE.structure, /always/i);
  assert.match(PROMOTION_RULE.values, /enum/i);
  assert.match(PROMOTION_RULE.production, /nothing|no values/i);
});

// --- the CLI command --------------------------------------------------------

test("`capabilities --json` reflects the resolved config's base URL", () => {
  const dir = sandbox({ v: 1, default: "local",
    environments: { local: { baseUrl: "http://127.0.0.1:9101" } } });
  const out = JSON.parse(cli(dir, {}, "capabilities", "--json"));
  assert.equal(out.egress.base_url, "http://127.0.0.1:9101");
  assert.ok(Array.isArray(out.writes) && out.writes.length, "writes are enumerated");
  assert.ok(out.promotion && out.promotion.production, "the promotion rule is present");
});

test("`capabilities` prints a human-readable manifest naming the boundary", () => {
  const dir = sandbox({ v: 1, default: "local",
    environments: { local: { baseUrl: "http://127.0.0.1:9101" } } });
  const out = cli(dir, {}, "capabilities");
  assert.match(out, /sannr\.json/);
  assert.match(out, /evidence/i);
  assert.match(out, /http:\/\/127\.0\.0\.1:9101/);
  assert.match(out, /promotion/i);
});

test('feedback capability describes voluntary pinned egress with no credentials, redirects or automatic schema fetch', () => {
  const manifest = capabilityManifest(inputs());
  const feedback = manifest.egress.feedback;
  assert.ok(feedback, 'optional first-party traffic must be visible independently of configured APIs');
  assert.equal(feedback.stack, 'sannr-feedback');
  assert.equal(feedback.send.url, 'https://sannr.dev/api/v1/feedback');
  assert.equal(feedback.send.method, 'POST');
  assert.equal(feedback.schema.url, 'https://sannr.dev/api/v1/feedback/schema');
  assert.equal(feedback.schema.automatic, false);
  assert.equal(feedback.default_policy, 'ask');
  assert.equal(feedback.authentication, 'none');
  assert.equal(feedback.redirects, false);
  assert.equal(feedback.retries, false);
  assert.match(feedback.guard, /human.*every|every.*human/i);
  assert.match(feedback.guard, /allow.*never/);
  assert.match(feedback.guard, /hostname.*reserved|reserved.*hostname/i);
  assert.match(renderCapabilities(manifest), /https:\/\/sannr\.dev\/api\/v1\/feedback/);
});

test('feedback capability exposes read-only packaged context, private receipt and global cooldown writes', () => {
  const manifest = capabilityManifest(inputs());
  const source = manifest.reads.find(row => row.id === 'feedback-stack');
  assert.ok(source); assert.match(source.guard, /read-only/); assert.match(source.guard, /repository.*cannot|cannot.*repository/);
  const receipt = manifest.writes.find(row => row.id === 'feedback-receipt');
  assert.ok(receipt); assert.equal(receipt.committed, false);
  assert.match(receipt.path, /feedback\/sent\/<ulid>\.json$/);
  assert.match(receipt.guard, /0600/); assert.match(receipt.guard, /before.*send|before.*request/);
  assert.match(receipt.guard, /gitignore/);
  const cooldown = manifest.writes.find(row => row.id === 'feedback-cooldown');
  assert.ok(cooldown); assert.equal(cooldown.committed, false);
  assert.match(cooldown.guard, /30 seconds/); assert.match(cooldown.guard, /atomic/);
  assert.match(renderCapabilities(manifest), /feedback.*sent.*ulid/);
});
