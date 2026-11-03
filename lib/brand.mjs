// THE NAME — one constant, everything else derived.
//
// Read this file first if you are renaming the product. The procedure is four
// steps and they are all below; everything else in lib/ and bin/ derives.
//
// The name is Sannr (chosen 2026-08-19); it arrived through this seam, and
// the seam stays, because a name that moved once can move again — and because
// spraying a name through 8,000 lines is how you pay later: a grep-and-replace
// across code, help text, on-disk filenames, delimiters in files we already
// wrote into a user's repo, and an MCP server key an agent addresses by string
// is exactly the change that breaks three of those and passes the tests anyway.
//
// So the rename is ONE EDIT: change PRODUCT below. Every user-visible mention,
// every derived filename, and every delimiter follows. test/connect.test.mjs
// pins that claim by renaming the product through the seam and asserting no
// command still prints the old name — the guarantee is checked, not promised.
//
//   RENAMING, IN FULL
//   1. edit PRODUCT here                      → all code, help, output, filenames
//   2. `sed -i '' s/sannr/newname/g` the PROSE_SURFACES listed below
//      (markdown assets and docs, which are prose and not derivable). One of
//      them is load-bearing beyond prose: skill/write-context/SKILL.md declares
//      `name: sannr-write` in its front matter, and Claude Code keys a
//      skill by the DIRECTORY it is installed under, which connect takes from
//      that declaration. Miss it and the rename leaves an old-name directory in
//      every user's repo.
//   3. package.json `name` (the scoped `@newname/newname`, see NPM_PACKAGE)
//      and its `bin` keys                     → the npm identity
//   4. `npm run test:full`                    → the rename test fails loudly if
//                                               step 1 was not actually enough,
//                                               and the inventory test fails if
//                                               PROSE_SURFACES has gone stale
//
// Nothing else in lib/ or bin/ may hardcode the name. That is the whole point,
// and three tests enforce it: a rename through the seam that no command's
// output may survive, an inventory check on PROSE_SURFACES in both directions,
// and a source check that forbids re-spelling a constant declared here.

import { existsSync, readFileSync } from "node:fs";
import { dirname, basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The name. Sannr — Old Norse "true" — chosen 2026-08-19 from a verified
// naming session.
//
// The environment override is a TEST SEAM, not a feature: it exists so the
// "one edit" claim above can be exercised end-to-end in a subprocess. It is
// deliberately not documented in --help, because a user who renames the product
// per-invocation gets a knowledge file whose name no longer matches the one in
// their repo, which is a worse failure than the one it would solve.
const PRODUCT_INPUT = process.env.API_CONTEXT_PRODUCT_NAME || "sannr";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(PRODUCT_INPUT))
  throw Object.assign(new Error("API_CONTEXT_PRODUCT_NAME must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/"), { code: "PRODUCT_INVALID" });
export const PRODUCT = PRODUCT_INPUT;
export const PROSE_PRODUCT_TITLE = "Sannr";

// The public feedback service is an explicit send destination, never a
// configurable upstream. The physical asset path stays stable in rename tests.
export const FEEDBACK_STACK_NAME = `${PRODUCT}-feedback`;
export const FEEDBACK_ORIGIN = "https://sannr.dev";
export const FEEDBACK_BASE_URL = `${FEEDBACK_ORIGIN}/api/v1`;
export const FEEDBACK_SEND_ENV = `${PRODUCT.toUpperCase().replaceAll("-", "_")}_FEEDBACK_SEND`;
export const FEEDBACK_ASSET_DIRECTORY = "stacks/sannr-feedback";

// The collection is a separate rename axis. Change this one default and run
// migrate; the layout marker remembers the previous directory identity.
const COLLECTION_INPUT = process.env.API_CONTEXT_COLLECTION_NAME || "stacks";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(COLLECTION_INPUT))
  throw Object.assign(new Error("API_CONTEXT_COLLECTION_NAME must be a portable directory name"), { code: "COLLECTION_INVALID" });
export const COLLECTION = COLLECTION_INPUT;
export const PROJECT_DIR_NAME = `.${PRODUCT}`;

// --- derived: the identifiers a user, a file, or a host sees -----------------

/** The bin name: the product's identity on a command line. */
export const BIN_NAME = PRODUCT;

/** The npm package name. npm refused the bare name on 2026-09-08 ("too similar
 * to existing packages" — its typosquat rule, no override exists), so the package
 * lives under a scope the owner holds: `@<name>/<name>`. The bin stays PRODUCT;
 * only install lines and the registry-mode CI installer carry this form. */
export const NPM_PACKAGE = `@${PRODUCT}/${PRODUCT}`;

/** Historical package/bin identities that a renamed install can leave on
 * PATH. This is evidence, not a guessing list: `api-context` is the exact bin
 * declared before the Sannr rename (git 4021430^). Doctor inspects only these
 * declared basenames and never executes a candidate. Add a name here only when
 * a future rename creates another real predecessor. */
export const LEGACY_BIN_NAMES = Object.freeze(["api-context", "api-request"]);

/**
 * How the tool is invoked ON THIS INSTALL — the string every instruction we
 * print or write into a user's repo must use.
 *
 * There are two installs, and only one of them puts the bin on PATH. A bare
 * checkout has a third honest form: the Node script that is running this CLI.
 * After
 * `npm install --save-dev`, `sannr doctor` is command-not-found, and
 * every "Run: …" line we print is then a small lie told to someone who
 * installed the tool CORRECTLY — including the pointer block committed into
 * their CLAUDE.md, where a teammate reads it weeks later with no way to know
 * which install the author used. That is the difference between a tool that
 * feels finished and one that feels like a prototype, and it costs one string.
 *
 * The discriminator is layout, not guesswork: npm puts a local dependency at
 * <project>/node_modules/<name>/ with a shim at <project>/node_modules/.bin/,
 * so if that shim exists next to us, it is the runnable form. A GLOBAL install
 * also sits under a node_modules, which is why the shim is what is checked
 * rather than the path shape — the global one is on PATH and the bare name is
 * right there.
 *
 * A bare checkout is invoked with `node bin/cli.mjs`; when that script is the
 * process entrypoint, preserve its actual path instead of inventing a bare command.
 * This is intentionally limited to the CLI entrypoint: importing the
 * brand seam from a library or test must not turn every example into a path to
 * the test runner.
 *
 * Resolved once, at load: an install does not change under a running process,
 * and a per-call check would make every string a function.
 */
function commandWord(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function checkoutInvocation() {
  const script = process.argv[1];
  return script && basename(script) === "cli.mjs"
    ? `node ${commandWord(script)}` : PRODUCT;
}

// npx installs into npm's cache (…/_npx/<hash>/node_modules) and puts its shim
// on PATH only for that one run. The shim exists, but a path to it is neither
// in the user's project nor stable, so the honest form is the exact npx command.
function npxInvocation(pkg) {
  try {
    const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    if (typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
      return `npx --yes ${NPM_PACKAGE}@${version}`;
  } catch { /* An unreadable manifest falls back to the bare name below. */ }
  return PRODUCT;
}

function invocation() {
  const here = dirname(fileURLToPath(import.meta.url));      // <pkg>/lib
  const pkg = dirname(here);                                 // <pkg>
  const parent = dirname(pkg);                               // …/node_modules or …/node_modules/@scope
  // Scoped packages sit one level deeper (…/node_modules/@scope/name). The
  // published package is scoped, so this is the installed case, not an edge.
  const modules = basename(parent).startsWith("@") ? dirname(parent) : parent;
  if (basename(modules) !== "node_modules") return checkoutInvocation(); // a clone, or a global prefix
  if (basename(dirname(dirname(modules))) === "_npx") return npxInvocation(pkg);
  const shim = join(modules, ".bin", PRODUCT);
  if (!existsSync(shim)) return PRODUCT;                     // global install: on PATH
  // Relative to the project root, which is where a user runs commands from.
  return `.${sep}${relative(dirname(modules), shim)}`;
}

/** How the tool is invoked on a command line, on THIS install. Transient
 *  terminal output uses this because it must be runnable in the current
 *  checkout/install. Committed instructions use POINTER_CLI_NAME below. */
export const CLI_NAME = invocation();

function portableCommandWord(value) {
  // Real package/bin names are narrow, but the rename seam deliberately drives
  // spaces and shell metacharacters. Use the same single-command-word quoting
  // as the local invocation; double quotes are insufficient on POSIX because
  // `$()` and backticks still execute inside them. The path itself keeps
  // forward slashes so committed bytes remain host-independent.
  return commandWord(value);
}

/** The command written into committed AGENTS.md / CLAUDE.md pointer blocks.
 *  It belongs to the project, not to the machine that last regenerated it. */
export const POINTER_CLI_NAME = portableCommandWord(`./node_modules/.bin/${PRODUCT}`);

/** The committed knowledge file. lib/context.mjs re-exports it as CONTEXT_FILE. */
export const CONTEXT_BASENAME = `${PRODUCT}.json`;

/** Portable graph artifacts: every reader and writer uses these identities. */
export const GRAPH_MANIFEST_BASENAME = `.${PRODUCT}-graph.json`;
export const GRAPH_SNAPSHOT_BASENAME = "graph.snapshot.json";
export const GRAPH_SNAPSHOT_KIND = `${PRODUCT}-graph`;

/** Explicit CI artifacts written into a project by `connect --ci`. */
export const CI_WORKFLOW_BASENAME = `${PRODUCT}.yml`;
export const CI_TARBALL_BASENAME = `${PRODUCT}-ci.tgz`;

// The delimiters around the pointer block written into AGENTS.md / CLAUDE.md.
// Derived, because they are a CONTRACT WITH THE PAST: unwire finds a previously
// written block by matching these exact strings. Renaming the product orphans
// every block already in a repo — a real cost, and the reason the rename
// procedure above says to run it before shipping the name, not after.
export const POINTER_BEGIN = `<!-- ${PRODUCT}:begin -->`;
export const POINTER_END = `<!-- ${PRODUCT}:end -->`;

// --- declared, NOT derived: the two names that must not move together --------

// The MCP tool name on the wire. An agent addresses it as a string
// (the host prefixes it with the registered server key), the reach harness classifies
// runs by it, and the F6 measurements are reported against it. It is a separate
// rename axis from the product name on purpose: the product may be called
// anything, the tool is the verb it performs.
export const TOOL_NAME = "api_request";

/** 2026-10-06, NAME-1: the server serves context as well as requests, so its
 * host key follows the product; the measured tool verb remains unchanged. */
export const MCP_SERVER_KEY = PRODUCT;
/** Recognition only: never register a new server with a historical key. */
export const LEGACY_MCP_SERVER_KEYS = Object.freeze(["api-request"]);
export const SKILL_NAMES = Object.freeze({ request: `${PRODUCT}-request`, write: `${PRODUCT}-write`, feedback: `${PRODUCT}-feedback` });
export const LEGACY_SKILL_NAMES = Object.freeze({ request: ["api-request"], write: ["write-context"], feedback: ["feedback"] });

// 2026-10-06, corrected R11: new usage and tokens join the registry under
// ~/.sannr (or SANNR_HOME). Legacy state stays readable in place, never moved
// or deleted: pinned older installs still need it. The historical pin is
// fallback recognition only in lib/machine-state.mjs.
export const STATE_DIR_NAME = PRODUCT;
export const LEGACY_STATE_DIR_NAME = "agent-api-poc";

// The machine-global home (~/.sannr): the cross-repo registry, new usage rows
// and token grants. Derived along with STATE_DIR_NAME above; prototype state
// remains an in-place read fallback for mixed-version installations.
//
// The env override is a FEATURE, not a test seam (contrast the PRODUCT
// override above): the fleet harness points every container and every
// generation at its own isolated home, and parallel experiments on one
// machine must never share grant state by accident. Derived from the product
// name like everything else, so the rename test exercises it for free.
export const GLOBAL_DIR_NAME = `.${PRODUCT}`;
export const ENV_PREFIX = PRODUCT.toUpperCase().replace(/[^A-Z0-9]/g, "_");
export const HOME_ENV_NAME = `${ENV_PREFIX}_HOME`;
export const ALLOW_SAVE_OUTSIDE_ENV_NAME = `${ENV_PREFIX}_ALLOW_SAVE_OUTSIDE`;

// --- the prose the rename cannot reach --------------------------------------

// Markdown is prose about the product, not derived from a constant, so a rename
// must touch these files by hand. Listed here so "which files?" has an answer
// that lives beside the constant instead of in someone's memory.
//
// Two tests pin it, in BOTH directions, because a half-checked inventory is the
// dangerous kind: one asserts every file listed here still mentions the name
// (no phantom entries sending the renamer to the wrong place), the other walks
// every markdown file in the repo and fails if one mentions the name and is not
// listed (no omissions quietly surviving the rename). The list was in fact
// missing four files before that second check existed.
export const PROSE_SURFACES = [
  // Ships to users — the copies that would still say the old name in someone
  // else's repo, where we would never see it.
  "lib/layout-README.md",          // template for the generated project directory guide
  "README.md",                     // shipped in the npm package
  "ALPHA.md",                      // private alpha entry point
  "skill/SKILL.md",                // repository API call convention
  "skill/write-context/SKILL.md",  // installed INTO a user's repo by connect;
                                   // its front-matter `name:` becomes the
                                   // installed DIRECTORY name (see step 2 above).
                                   // Its COMMAND LINES are not prose and are
                                   // not your problem: connect.renderSkill
                                   // rewrites them to this install's CLI_NAME
                                   // on the way in, so they follow the rename
                                   // like code does.
  "skill/feedback/SKILL.md",       // installed INTO a user's repo by connect;
                                   // same front-matter/directory rule as above.
  "CHANGELOG.md",                  // shipped in the npm package; what changed per version
  // Ours: docs, plans, and the harness protocols.
  "CLAUDE.md",                     // the agent-facing conventions file; added
                                   // 2026-08-21 after the inventory test caught
                                   // it missing — the second direction working
                                   // exactly as designed. (CLAUDE.local.md is
                                   // NOT here: untracked machine-local state is
                                   // outside the rename's jurisdiction, like
                                   // the state dir — the inventory walks what
                                   // git ships.)
  "PRD.md",
  "GOAL.md",
  "FINISH.md",
  "ROADMAP.md",
  "harness/protocol.md",
  "harness2/protocol.md",
  "fleet/SPEC.md",                 // the agent test fleet's binding spec
  "fleet/BOOTSTRAP.md",            // the fleet's fresh-machine runbook, written for an agent
  "SETUP.md",                      // the front door for an agent on a fresh machine:
                                   // how to use the product, and how to run the fleet
  "BACKLOG.md",                    // private planning backlog
  "docs/stacks.md",                 // named API stack routing and isolation
  "docs/feedback.md",               // explicit feedback sends, receipt and policy
  "docs/layout.md",                 // the committed-directory and migration guide
  "docs/README.md",                 // portable-relative agent documentation
  "docs/agent-guide.md",            // canonical agent operating guide
  "docs/agent-examples.md",         // copy-and-run agent workflows
  "docs/quickstart.md",
  "docs/install.md",               // setup reference; copied to START-HERE.md in the alpha ZIP
  "docs/privacy.md",               // what is stored where and what leaves the machine
  "docs/limitations.md",           // known limitations in one place
  "docs/troubleshooting.md",       // known setup problems and their fixes
  "SUPPORT.md",                    // where to ask; shipped in the npm package
  "docs/install-prompt.md",        // canonical text quoted by README and launch surfaces
  "docs/ci.md",
  "docs/imports.md",
  "docs/discovery.md",              // contract discovery and static scanner limits
  "docs/survey.md",                 // explicit portable API graph and snapshot semantics
  "docs/mcp.md",
  "docs/protocols.md",
  "docs/api-call-policy.md",
  "docs/network-behavior.md",       // shipped network destinations and triggers
  "docs/agent-first-alpha-prd.md",
  "docs/dependency-graph-design.md",
  "docs/dependency-graph.md",
  "docs/view.md",
  "docs/overhead-milestone.md",     // measurement-first estimate and checkpoint plan
  "docs/sessions.md",               // the session ledger (sessions command and view section)
  "docs/saved-requests.md",         // portable request format and headless reuse
  "docs/workbench.md",              // operator launch, pairing and workflows
  "docs/workbench-security.md",     // what a paired Workbench page can reach, and its limits
  "docs/workbench-progress.md",     // implementation checkpoints and handoff notes
  "docs/workbench-goal.md",         // accepted product-local engineering specification
  "docs/workbench-owner-walkthrough.md", // owner candidate walkthrough and pending checks
  "docs/note-history.md",
  "reports/demo-launch-pilot-qa.md",
  "reports/demo-launch-pilot-protocol.md",
  "reports/agent-lifecycle-eval-protocol.md",
  "reports/envelope-overhead-2026-08-24.md",
  "reports/launch-gaps-1-2.md",
  "reports/agent-tooling-lifecycle.md",
  "reports/agent-lifecycle-eval-qa.md",
  "reports/agent-knowledge-workflow.md",
  "reports/agent-lifecycle-eval-v2-protocol.md",
  "reports/agent-lifecycle-eval-v2-qa.md",
  "reports/alpha5-install-trust-qa.md",
  "reports/alpha5-release-candidate.md",
  "reports/workbench-ui-pass1/README.md",
  "reports/workbench-ui-pass2/README.md",
  "reports/manual-e2e/README.md",
  "reports/manual-e2e/fixes.md",
  "packaging/README.md",
  "packaging/alpha/INSTALL.md",    // rendered as the private alpha ZIP's INSTALL.txt prompt
  "SECURITY.md",                   // community file: names the product in its scope
  "CONTRIBUTING.md",               // contributor setup and package validation commands
  "TRADEMARK.md",                  // community file: the mark itself
  "CODE_OF_CONDUCT.md",            // community file: its reporting address is on the product domain
  "packaging/CLAUDE.public.md",    // the public repository's agent-conventions file; the
                                   // release assembly copies it to CLAUDE.md and AGENTS.md
  "AGENTS.md",                     // the public tree's copy of the conventions file (Codex
                                   // and other hosts read this name); may be absent here
];

// The public repository is a SUBSET of this one. These prose surfaces exist
// only in the full repository (the private work order, planning documents,
// and the alpha handoff) and are absent from a public
// cut; the seam test allows their absence and nothing else's. Tests that read
// one of them skip BY NAME when it is missing — a skip is visible, never silent.
export const PRIVATE_SURFACES = [
  "ALPHA.md", "CLAUDE.md", "AGENTS.md", "PRD.md", "GOAL.md", "FINISH.md", "ROADMAP.md",
  "SETUP.md", "BACKLOG.md",
  "docs/agent-first-alpha-prd.md",
  // Internal planning and owner-review documents: they name people, decisions
  // and work orders. Kept in the private repository, out of the public cut.
  "docs/overhead-milestone.md", "docs/workbench-goal.md",
  "docs/workbench-owner-walkthrough.md", "docs/workbench-progress.md",
  // Research, its reports and the build-status ledger remain private; nothing
  // under reports/ is copied into the product-only public source assembly.
  "harness/protocol.md", "harness2/protocol.md", "fleet/SPEC.md", "fleet/BOOTSTRAP.md",
  "reports/envelope-overhead-2026-08-24.md",
  "reports/demo-launch-pilot-qa.md", "reports/demo-launch-pilot-protocol.md",
  "reports/agent-lifecycle-eval-protocol.md", "reports/launch-gaps-1-2.md",
  "reports/agent-tooling-lifecycle.md", "reports/agent-lifecycle-eval-qa.md",
  "reports/agent-knowledge-workflow.md", "reports/agent-lifecycle-eval-v2-protocol.md",
  "reports/agent-lifecycle-eval-v2-qa.md",
  "reports/alpha5-install-trust-qa.md",
  "reports/alpha5-release-candidate.md",
  "reports/workbench-ui-pass1/README.md",
  "reports/workbench-ui-pass2/README.md",
  "reports/manual-e2e/README.md",
  "reports/manual-e2e/fixes.md",
  // The private alpha ZIP handoff: beta and later releases install from npm.
  "packaging/alpha/INSTALL.md",
];
