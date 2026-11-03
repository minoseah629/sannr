import { LAYOUT } from './layout.mjs';
// CAPABILITIES — the tool's self-report of its security-relevant filesystem
// capability classes and the network destinations it can contact.
//
// The value of a manifest is entirely in whether it is TRUE. A hand-written
// paragraph in a README drifts the moment the code moves and nobody notices;
// the reviewer who trusts it is worse off than one who read nothing. So this
// module owns no fixed-path facts of its own that it could get wrong: every FIXED write-
// path is the writer's OWN constant (CONTEXT_FILE, SUITE_DIR, BASELINE_FILE,
// POINTER_FILES, the CI artifact basenames, and the client's evidence/usage/token paths). The one write
// with no fixed path — save_to, which the caller names — is disclosed as
// exactly that: an unrestricted destination, not a constant to pin. Dynamic
// redirect egress is disclosed as a class because its concrete destination is
// selected by an upstream response and cannot be known at manifest time. Every
// configured egress destination, including each per-host oauth token endpoint,
// is read back from the resolved config, never asserted. A test
// (test/capabilities.test.mjs) exercises the real promotion boundary and pins
// the manifest's words to what promoteObservation actually does, so the rule
// stated here cannot drift into a comforting fiction either.
//
// The manifest is data, rendered two ways: --json for machines, a terminal
// block for a human. The CLI (bin/cli.mjs) gathers the inputs — config from
// resolveConfig, the client-side paths from lib/client.mjs — and hands them in.

import { homedir } from "node:os";
import {
  CI_TARBALL_BASENAME, CI_WORKFLOW_BASENAME, CLI_NAME, BIN_NAME,
  MCP_SERVER_KEY, STATE_DIR_NAME, ALLOW_SAVE_OUTSIDE_ENV_NAME,
  FEEDBACK_STACK_NAME, FEEDBACK_ORIGIN, FEEDBACK_BASE_URL, FEEDBACK_SEND_ENV, FEEDBACK_ASSET_DIRECTORY,
} from "./brand.mjs";
import { CONTEXT_FILE } from "./context.mjs";
import { SUITE_DIR } from "./suites.mjs";
import { BASELINE_FILE } from "./ci.mjs";
import { FEEDBACK_RECEIPTS_DIRECTORY, FEEDBACK_COOLDOWN_BASENAME, FEEDBACK_LOCK_BASENAME, FEEDBACK_COOLDOWN_MS } from "./feedback-send.mjs";

// The files init/learn write their pointer block into. Owned HERE, imported by
// bin/cli.mjs, so the writer and the manifest can never disagree about the set:
// a manifest that named a different list than the code writes would be exactly
// the fiction this command exists to prevent.
export const POINTER_FILES = ["AGENTS.md", "CLAUDE.md"];

// The promotion rule in force, stated so a reviewer can check it against
// lib/promote.mjs. The test does the checking: it drives promoteObservation and
// asserts each clause below is what the boundary enforces.
export const PROMOTION_RULE = {
  structure: "always — field names, types, cardinality, and status codes are schema, not data, and are already implied by any published contract",
  values: "only when the contract declares that field's value set as an enum, and then only the declared members (an undeclared value observed on an enum field is refused, its existence surfaced as a count)",
  production: "nothing — an environment marked production promotes no field values at all, as defence in depth",
};

// Present an absolute path the way a reader recognises it: repo-relative when it
// lives inside the repo, home-collapsed otherwise. Never fabricated — the input
// is the real path the code computed.
function display(root, p) {
  if (!p) return p;
  if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  const home = homedir();
  return p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

/**
 * Build the capability manifest from the inputs the CLI gathered. Pure: no I/O,
 * no config resolution, so the test can drive it with controlled values.
 *
 * @param {object} in
 * @param {string} in.root                 repo root, for relative display
 * @param {object} in.config               resolveConfig() result (baseUrl, hosts)
 * @param {string} in.evidence             the client's evidence directory (absolute)
 * @param {string} in.usageLog             the client's usage-log path (absolute)
 * @param {string} in.tokenCache           the OAuth token-cache path (absolute)
 * @param {string|null} in.tokenUrl        API_OAUTH_TOKEN_URL, or null
 */
export function capabilityManifest({ root, config, evidence, usageLog, tokenCache, tokenUrl, oauthTokenUrls }) {
  const reads = [
    { id: "feedback-stack", path: `<installed package>/${FEEDBACK_ASSET_DIRECTORY}/`,
      contains: "the packaged API configuration, OpenAPI schema and day-one knowledge for optional feedback",
      guard: `read-only; repository files cannot replace the '${FEEDBACK_STACK_NAME}' stack or redirect it; no schema fetch occurs automatically` },
    { id: "project-inputs", path: "<repository files selected by the invoked command>",
      contains: `source files, API contracts, ${LAYOUT.environments}, ${CONTEXT_FILE}, saved suites, baselines, and host configuration needed by map/audit/connect/verify/status`,
      guard: "commands read only the inputs needed for that operation; map and audit may recursively inspect the selected repository tree" },
    { id: "configured-env-files", path: "<each configured envFile or API_ENV_FILE path>",
      contains: "environment-variable assignments, which may include credentials",
      guard: "loaded only when explicitly referenced by configuration; values remain process-local and are not included in the capability report" },
    { id: "local-state", path: "<configured evidence, usage-log, and OAuth-cache paths>",
      contains: "existing evidence for inspection, usage rows for receipts, and cached OAuth tokens for reuse",
      guard: "read only by the corresponding inspection, receipt, or authenticated-request path; reports count both usage logs; tokens use the current cache first, then a missing entry's legacy fallback in place; linked stores are never read" },
    // Multipart upload is an explicit local-file capability. The path comes
    // from the MCP caller and is not confined to the repo, so omitting it from
    // a security self-report would hide the broadest read surface Codex can
    // grant this server.
    { id: "upload-files", path: "<any caller-named readable path>",
      contains: "local file bytes read for a multipart upload (the files MCP parameter)",
      guard: "only when files is passed; bytes are sent only to a configured API origin, and Codex is configured to prompt for this polymorphic tool" },
  ];
  const writes = [
    { id: "feedback-receipt", path: `${FEEDBACK_RECEIPTS_DIRECTORY}/<ulid>.json`, committed: false,
      contains: "the exact anonymized JSON body prepared for an optional feedback send, including supplied prose and score",
      guard: "written 0600 before any send; a local .gitignore excludes receipts; credential, path and private-identifier scans run first; unsafe linked destinations refuse" },
    { id: "feedback-cooldown", path: `<machine home (~/.${STATE_DIR_NAME} or configured home)>/${FEEDBACK_COOLDOWN_BASENAME} and ${FEEDBACK_LOCK_BASENAME}`, committed: false,
      contains: "the last feedback attempt time and an exclusive preparation lock shared across local repositories",
      guard: `private atomic reservation; another attempt within ${FEEDBACK_COOLDOWN_MS / 1000} seconds is refused locally with retry timing; failed or uncertain attempts retain the reservation; no automatic retry` },
    // Committed, and the whole reason the promotion boundary exists.
    { id: BIN_NAME, path: CONTEXT_FILE, committed: true,
      contains: "API knowledge: response shapes, cardinality, contract-declared enums, and provider/environment/protocol-scoped observations with source attribution",
      guard: "legacy values pass the promotion boundary (lib/promote.mjs); protocol observations retain bounded structure without payload values, distinguish external claims from client observations, and preserve explicit omissions" },
    // Committed, but only on explicit opt-in and always removable.
    ...POINTER_FILES.map((f) => ({ id: `pointer:${f}`, path: f, committed: true,
      contains: `a delimited ${BIN_NAME} pointer block steering agents to the knowledge file`,
      guard: "opt-in (init --agents); delimited, idempotent, removed in one command (unwire)" })),
    // The wiring `connect` performs. Both land in the repo and both edit files
    // the user owns, so they are disclosed with the guard that makes that safe:
    // one key merged into an existing MCP config (never a wholesale rewrite),
    // and skills installed under their own declared names.
    { id: "primary-contract-binding", path: LAYOUT.environments, committed: true,
      contains: "the selected environment's relative primary contract path",
      guard: "start/connect persists unique local discovery only for an explicitly configured primary base; start --contract makes an explicit selection; unrelated environments, hosts and fields are preserved; ambient URL/contract overrides do not rewrite config; ambiguous discovery and linked paths are refused before setup writes; dry-run only plans the binding" },
    { id: "mcp-registration", path: ".mcp.json and .codex/config.toml (plus .cursor/mcp.json, .vscode/mcp.json when present)", committed: true,
      contains: `one host-native, machine-local MCP server entry named '${MCP_SERVER_KEY}': the absolute runtime, server, context, evidence, and config paths — no credentials, ever`,
      guard: "host-defined project config, which may be committed; written only by connect and MERGED into existing config (every other server preserved), a same-name entry it cannot safely recognise is a conflict, removed by unwire; regeneration is idempotent and corrects absolute paths for this machine, so teammates re-run connect after cloning" },
    { id: "skills", path: `${LAYOUT.skills}/<skill>/SKILL.md plus .claude/skills/<skill>/SKILL.md and .agents/skills/<skill>/SKILL.md`, committed: true,
      contains: "the agent-facing skills shipped with this package: when the client earns its place, and the write convention for recording what a spec does not say",
      guard: "installed only by connect with command lines tier-rendered: a verified portable repo command or explicit non-command omission; unwire removes generated copies and LEAVES any prose you have edited" },
    { id: "claude-shell-http-hook", path: ".claude/settings.local.json", committed: false,
      contains: "one Claude Code PreToolUse command hook for shell curl/wget targeting this repo's configured API base URLs; machine-local runtime and doctor paths plus an opaque ownership digest, never intercepted command arguments",
      guard: "written only by explicit connect --claude-hook; merged beside unrelated local settings, a different managed entry is a conflict, and unwire removes only the integrity-bound generated entry; Codex has no hook written" },
    { id: "ci-workflow", path: `.github/workflows/${CI_WORKFLOW_BASENAME}`, committed: true,
      contains: "a GitHub Actions workflow for push, pull-request, and weekly API audit/freshness summaries",
      guard: "written only by explicit connect --ci; foreign or linked bytes are a no-clobber conflict; platform permissions are contents:read and active audits stay report-only + no-execute; unwire removes only the exact versioned generated template" },
    { id: "ci-vendored-engine", path: LAYOUT.ciTarball, committed: true,
      contains: "the installable self-pack of this engine used by the generated CI workflow",
      guard: "written only by explicit connect --ci in vendored mode as an atomic pair with the workflow; an explicit install-mode switch removes only the prior digest-matching archive; engine-root package allowlist rejects evidence/results, nested archives, secret-shaped names, and symlinks; bundled dependencies require exact pinned file hashes (including a few upstream configuration dotfiles); unwire removal requires the generated workflow's matching digest" },
    { id: "suites", path: `${SUITE_DIR}/<name>.json`, committed: true,
      contains: "saved, re-runnable request suites (standard request envelopes)",
      guard: "secret-scanned before write; the name is validated as a slug, never a path" },
    { id: "audit-baseline", path: BASELINE_FILE, committed: true,
      contains: "the audit's accepted-findings baseline, for --ci to diff against",
      guard: "written only by audit --baseline; meant to be committed and reviewed" },
    { id: "map-output", path: `${LAYOUT.mapOutput} or a caller-named --out path`, committed: false,
      contains: "a self-contained HTML rendering of the derived API footprint",
      guard: "written only by map without --json/--text; destinations outside the surveyed project require --allow-outside-project; symbolic links, hardlinks, and linked ancestors are refused even with that flag" },
    // Not committed. Evidence is the dangerous one: complete bodies and headers.
    { id: "evidence", path: `${display(root, evidence)}/`, committed: false,
      contains: "COMPLETE request/response pairs — every body, every header, unredacted apart from configured secrets",
      guard: "self-ignored: a .gitignore is written INSIDE the directory so a `git add -A` cannot stage it, and the client warns if any evidence is already tracked" },
    { id: "usage-log", path: display(root, usageLog), committed: false,
      contains: "append-only usage log: request shape and origin only — never bodies, headers, or query values",
      guard: `outside the repo by default (~/.${STATE_DIR_NAME}/)` },
    { id: "token-cache", path: display(root, tokenCache), committed: false,
      contains: "cached OAuth access tokens (only when oauth auth is configured)",
      guard: "written 0600, keyed by a hash of provider and credential set; credential rotation selects a new cache entry; no credential values in filenames; outside the repo" },
    { id: "legacy-state-notice", path: `<machine home (~/.${STATE_DIR_NAME} or configured home)>`, committed: false,
      contains: "a private receipt naming legacy-state files already reported by doctor; never file contents",
      guard: "new usage rows, grants and notice receipts write only to current state; legacy state is never moved, renamed or deleted" },
    // The one write with NO fixed path: the save_to MCP parameter redirects a
    // binary response body to a caller-named absolute path (client.mjs:
    // resolve(save_to)). It escapes evidence/, the repo, and every entry above,
    // so the manifest that omitted it would be under-reporting its most
    // dangerous write, not its least. Named here so the self-report is complete.
    { id: "save_to", path: "<caller-named path under project/evidence by default>", committed: false,
      contains: "a binary response body written verbatim to a path the CALLER names (the save_to MCP parameter)",
      guard: `bounded to the project root or evidence directory by default; ${ALLOW_SAVE_OUTSIDE_ENV_NAME}=1 explicitly permits outside-project output; symlinks and hardlinks are refused` },
  ];

  // Egress. Two questions: which UPSTREAMS receive requests, and which endpoints
  // receive CREDENTIALS. Both are read back from config, never asserted.
  //
  // Upstreams: the base URL plus each host's baseUrl (the per-host multi-
  // credential map; each entry's baseUrl is a distinct origin).
  const hosts = {};
  for (const [name, h] of Object.entries(config?.hosts ?? {}))
    if (h?.baseUrl) hosts[name] = h.baseUrl;

  // The client supplies destinations using its actual provider-local env-file
  // scopes and inherited environment precedence. This manifest remains pure.
  // The older controlled-input form still describes explicitly supplied URLs;
  // it must never invent a fallback from one provider's file to another host.
  const tokenUrls = new Set(oauthTokenUrls ?? []);
  if (oauthTokenUrls === undefined) {
    if (tokenUrl) tokenUrls.add(tokenUrl);
    for (const h of Object.values(config?.hosts ?? {})) {
      if (typeof h?.auth === "string" && h.auth.split(":")[0] === "oauth" && h.tokenUrl)
        tokenUrls.add(h.tokenUrl);
    }
  }

  const egress = {
    base_url: config?.baseUrl ?? null,
    hosts,
    oauth_token_urls: [...tokenUrls].sort(),
    redirect_destinations: "any HTTP(S) origin named by a redirect response from a configured upstream",
    note: "cross-origin redirects may contact an origin not listed above, but configured credentials and non-allowlisted headers are dropped; only safe request-negotiation headers may remain; redirects to the reserved feedback hostname are refused",
    feedback: {
      stack: FEEDBACK_STACK_NAME, origin: FEEDBACK_ORIGIN,
      send: { method: "POST", url: `${FEEDBACK_BASE_URL}/feedback` },
      schema: { method: "GET", url: `${FEEDBACK_BASE_URL}/feedback/schema`, automatic: false },
      default_policy: "ask", authentication: "none", redirects: false, retries: false,
      guard: `ask requires the human's yes for every send; allow is explicit and requires disclosure; never refuses, including ${FEEDBACK_SEND_ENV}=never; the hostname is reserved for this built-in stack; exact fixed-shape responses only, ambient credentials withheld`,
    },
  };

  return {
    version: 1,
    scope: "security-relevant filesystem capability classes and network destination classes; paths within a selected source tree are grouped rather than enumerated file-by-file",
    reads, writes, egress,
    listeners: [{ id: "map-preview", protocol: "http", address: "127.0.0.1", port: "ephemeral",
      contains: "one immutable generated HTML map at an unpredictable route; loopback listener in a detached worker",
      guard: "starts only with map --preview; --no-preview, --json and --text prevent startup; expires after 30 minutes; receipt prints the worker pid and stop command; exact Host and route required; no filesystem request handler" }],
    promotion: PROMOTION_RULE,
  };
}

// --- rendering --------------------------------------------------------------

export function renderCapabilities(m) {
  const lines = [];
  lines.push(`${CLI_NAME} capabilities — security-relevant filesystem and network capability classes.`,
    `scope: ${m.scope}`, "");

  lines.push("FILES / PATHS IT MAY READ", "");
  for (const r of m.reads ?? []) {
    lines.push(`  ${r.path}`);
    lines.push(`      ${r.contains}`);
    lines.push(`      guard: ${r.guard}`);
  }

  lines.push("", "FILES / PATHS IT MAY WRITE", "");
  const committed = m.writes.filter((w) => w.committed);
  const local = m.writes.filter((w) => !w.committed);
  lines.push("  committed (lands in the repo, permanent in git history):");
  for (const w of committed) {
    lines.push(`    ${w.path}`);
    lines.push(`        ${w.contains}`);
    lines.push(`        guard: ${w.guard}`);
  }
  lines.push("", "  not committed by the tool (caller-selected paths may still point inside a repo):");
  for (const w of local) {
    lines.push(`    ${w.path}`);
    lines.push(`        ${w.contains}`);
    lines.push(`        guard: ${w.guard}`);
  }

  lines.push("", "NETWORK EGRESS", "");
  lines.push(`  base URL:         ${m.egress.base_url ?? "(none configured)"}`);
  const hostNames = Object.entries(m.egress.hosts);
  if (hostNames.length) {
    lines.push("  per-host upstreams:");
    for (const [name, url] of hostNames) lines.push(`    ${name.padEnd(16)} ${url}`);
  } else {
    lines.push("  per-host upstreams: (none configured)");
  }
  const tokenUrls = m.egress.oauth_token_urls ?? [];
  if (tokenUrls.length) {
    lines.push("  OAuth token URLs (credentials POSTed here):");
    for (const u of tokenUrls) lines.push(`    ${u}`);
  } else {
    lines.push("  OAuth token URLs:  (none — no oauth auth configured)");
  }
  lines.push(`  redirects:         ${m.egress.redirect_destinations}`);
  lines.push(`  ${m.egress.note}`);
  if (m.egress.feedback) {
    const feedback = m.egress.feedback;
    lines.push(`  optional feedback: ${feedback.send.method} ${feedback.send.url}`,
      `  manual schema:     ${feedback.schema.method} ${feedback.schema.url} (never fetched automatically)`,
      `  feedback guard:    ${feedback.guard}`);
  }

  lines.push("", "NETWORK LISTENERS", "");
  for (const listener of m.listeners ?? []) {
    lines.push(`  ${listener.protocol}://${listener.address} (${listener.port} port)`);
    lines.push(`      ${listener.contains}`);
    lines.push(`      guard: ${listener.guard}`);
  }

  lines.push("", "PROMOTION RULE (what may reach the committed knowledge file)", "");
  lines.push(`  structure:  ${m.promotion.structure}`);
  lines.push(`  values:     ${m.promotion.values}`);
  lines.push(`  production: ${m.promotion.production}`);

  return lines.join("\n");
}
