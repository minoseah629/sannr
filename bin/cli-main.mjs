#!/usr/bin/env node
// sannr — build and inspect the shared API knowledge file.
//
//   sannr init              inventory the contract, write sannr.json
//   sannr learn [--env e]   execute safe reads, promote what is allowed
//   sannr doctor            setup health; status/check/health/ping are aliases
//   sannr show <op>         one operation's detail
//
// No execution happens in `init`. `learn` executes GET/HEAD only, never writes.

import { codePathWithheld, forOperationCode, withCodeLocations } from '../lib/code-locations.mjs';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  CONTEXT_FILE as LEGACY_CONTEXT_FILE, MAX_CONTEXT_BYTES, readContract, operationsFrom, responseSchema, mapSourceFiles,
  sourceFileFor, emptyContext, loadContext, loadContextSnapshot, inspectContext,
  saveContext, saveContextNote, acceptNoteHistory, inspectNoteHistory, baselineNoteHistory, indexOf,
  freshnessFor, learnFromResponse, promotionPreview, liveContractDigest,
  noOperationsReason, provenanceStamp, ageReason, activeNotes,
  recordReachabilityFailure, recordLearnFailure, mergeVerifiedEntry,
} from "../lib/context.mjs";
import { noteEntries, noteKeyLabel, validNoteOperations } from "../lib/note-key.mjs";
import { recordNoteReview, retireNote, noteReviewFailure } from '../lib/note-review-actions.mjs';
import { reviewError, validateReviewActor } from '../lib/note-reviews.mjs';
import { readAccountFacts, writeAccountFact } from "../lib/account-facts.mjs";
import { contextFileFor, currentStackScope, withStackScope } from "../lib/stack-scope.mjs";
import { projectPathProblem as setupPathProblem } from "../lib/connect.mjs";
import { stackCatalog, resolveStack, stackScope, createStack, planStack, stackNameFromTitle, isBuiltinStack, isBuiltinFeedbackTarget, assertWritableStack } from "../lib/stacks.mjs";
import { detectFirstStack, stackNameFromHost } from "../lib/first-stack.mjs";
import { resolveConfig, authReadiness, credentialEnvironment, FALLBACK_BASE_URL, BUILTIN_DEFAULTS } from "../lib/config.mjs";
import { parseAuthReference } from "../lib/auth-reference.mjs";
import {
  PRODUCT, CLI_NAME, MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEYS, LEGACY_SKILL_NAMES, POINTER_BEGIN, POINTER_END, HOME_ENV_NAME, NPM_PACKAGE,
  CI_TARBALL_BASENAME, CI_WORKFLOW_BASENAME, GRAPH_MANIFEST_BASENAME, FEEDBACK_STACK_NAME, CONTEXT_BASENAME,
} from "../lib/brand.mjs";
import { loadRegistry, saveRegistry, registerRepo, resolveRef, registryPath,
  grant as addGrant, revoke as dropGrant, crossLookup } from "../lib/registry.mjs";
import { capabilityManifest, renderCapabilities, POINTER_FILES } from "../lib/capabilities.mjs";
import { findSurfaces, auditSurface, deriveEdges, baseUrlFor, upstreamUrls } from "../lib/audit.mjs";
import { severityFor, ciFindings, diffBaseline, writeBaselineFile, readBaselineFile,
  appendCiSummary, renderCiSummary, summaryCell, BASELINE_FILE } from "../lib/ci.mjs";
import { crossRepoRequiredFieldFindings } from "../lib/checks.mjs";
import { platformConsistency } from "../lib/consistency.mjs";
import {
  VERDICT_STATES, VERDICT_CLASSES, secretIn, validateVerdict, recordVerdict,
  renderVerdict, isExpired,
} from "../lib/verdicts.mjs";
import {
  SUITE_DIR, normalizeSuite, suiteSecretProblems, saveSuite, listSuites,
  loadSuite, suiteReport,
} from "../lib/suites.mjs";
import { readOnlyPlan, driftFrom } from "../lib/verify.mjs";
import { reviewCandidates, reviewCandidateFor } from "../lib/curate.mjs";
import { buildMapModel, footprintModel, renderMapText, renderMapHtml } from "../lib/map.mjs";
import { renderMapReceipt } from "../lib/map-terminal.mjs";
import { terminalText } from "../lib/terminal.mjs";
import { reconciliationModel, renderReconciliationText, renderReconciliationGfm } from "../lib/reconcile.mjs";
import { advertisementPlan, commandOmission, pinnedMcpPackage } from "../lib/advertisement.mjs";
import { inspectMcp, storeMcpInspection } from "../lib/mcp-inspect.mjs";
import { parseMcpInspectOptions, safeMcpSummaryPath, writeMcpSummary } from "../lib/mcp-options.mjs";
import { discoverMcpRegistrations } from "../lib/mcp-registrations.mjs";
import { safeMcpValue } from "../lib/mcp-facts.mjs";
import { renderMcpReport } from "../lib/mcp-report.mjs";
import { inspectedToolFor, renderInlineMcp } from "../lib/mcp-delivery.mjs";
import { blockText, blockCode, hasCommentMarkup, assertManagedBody, BLOCK_TEXT_MAX } from "../lib/block-text.mjs";
import { registeredContextTools, renderInheritedLessons, renderStackContext } from "../lib/pointer-context.mjs";
import { safeOutputPath as inspectOutputPath, writeOutputFile } from '../lib/output-path.mjs';
import { auditMcpDeclarations } from "../lib/mcp-audit.mjs";
import { resolveOutputPath } from "../lib/output-path.mjs";
import { evidenceDirectory, retainViewModel, writeViewFile, secretOnPage } from "../lib/view-records.mjs";
import { buildApiMapModel, renderApiMapHtml, renderApiMapText, apiMapSummary, selectContractFile } from "../lib/api-map.mjs";
import { setupGuidance, setupReceipt, renderSetupReceipt } from "../lib/onboarding.mjs";
import { installPointerSentence, doctorSummaryLine, renderDoctorZen } from "../lib/install-voice.mjs";
import { doctorTargetUrl, queryDoctorObservation, recordDoctorObservation, renderDoctorObservation } from "../lib/doctor-observation.mjs";
import { currentSetupBinding } from "../lib/setup-binding.mjs";
import { planSetupContract } from "../lib/setup-contract.mjs";
import { emptyApiDiscoveryNext, emptyContractDiscoveryNext } from '../lib/discovery-guidance.mjs';
import { captureOperationContext, queryOperationContext, migrateOperationContext } from "../lib/operation-context.mjs";
import { contextCommandError } from "../lib/context-errors.mjs";
import { backfillKeySources, renderKeySourceReport } from "../lib/key-source-evidence.mjs";
import { importedClaimBindings, prepareImportedTestClaims, saveImportedTestClaims,
  importedTestClaimCounts, inspectImportedTestClaims } from '../lib/imported-test-claims.mjs';
import { resolveNoteEvidence } from '../lib/note-evidence.mjs';
import { noteBasisStamp, NOTE_BASIS_KINDS } from '../lib/note-basis.mjs';
import { noteDataText, noteCorrectionConflicts, NOTE_DATA_MEANING, decorateNoteRecord } from '../lib/note-projection.mjs';
import { loadNoteReadContext, reviewLaneSummary, reviewAuthorSummary } from '../lib/note-read-model.mjs';
import { configuredHttpContracts, loadHttpContract, httpContractMountInfo } from '../lib/http-operation-context.mjs';
import { showObservationSummary, observationConfidence } from '../lib/show-observations.mjs';
import { planPointers, refreshNotePointers, inspectPointerFiles, pointerPathProblem, writableDestinationProblem, containsMachineLocalPath } from '../lib/note-pointers.mjs';
import { stacksMigrationRequired } from '../lib/stack-migration-state.mjs';
import { readDraftNote, markDraftNoteAccepted } from '../lib/draft-notes.mjs';
import { stackEvidenceClasses, formatEvidenceClassCounts, evidenceClass, projectKnownNotes, rankNoteRecords } from '../lib/evidence-confidence.mjs';

function requireStackMigrationBeforeWriting(root) {
  const refusal = stacksMigrationRequired(root);
  if (refusal) die(refusal.code, refusal.message, refusal.command);
}

import { LAYOUT, LEGACY_LAYOUT, layoutFor, planLayout, ensureLayout, inspectLayoutReadme, legacyLayoutEntries, migrateLayout, projectedLayoutFiles } from "../lib/layout.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function safeOutputPath(...args) {
  try { return inspectOutputPath(...args); }
  catch (error) { die(error.code, error.message, 'Choose a regular, single-link output file with unlinked parent directories.'); }
}

function resolveUserOutputPath(root, flag, { allowOutside = false, defaultInside = false, directory = false } = {}) {
  const target = resolve(flag);
  const base = resolve(root);
  const inside = target === base || target.startsWith(`${base}${sep}`);
  if (!inside && !allowOutside && !defaultInside)
    die("OUTPUT_OUTSIDE_PROJECT", `${flag} resolves outside the project; pass --allow-outside-project for this destination.`, "Use a project-local output or add the explicit allow flag.");
  return safeOutputPath(target, { directory });
}

function packageVersion() {
  try { return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version ?? "unknown"; }
  catch { return "unknown"; }
}

function packageGitHash() {
  // Do not borrow the commit of a consumer repo that happens to contain an
  // installed copy under node_modules. A hash belongs to this package only
  // when its own root is a checkout.
  if (!existsSync(join(PACKAGE_ROOT, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

function printVersion() {
  const hash = packageGitHash();
  let buildId = null;
  try {
    const metadata = JSON.parse(readFileSync(join(PACKAGE_ROOT, "lib", "build-info.json"), "utf8"));
    if (/^[0-9a-f-]{36}$/.test(metadata.buildId)) buildId = metadata.buildId;
  } catch { /* An unpackaged source checkout has no build identity. */ }
  console.log(`${CLI_NAME} ${packageVersion()}${hash ? ` (${hash})` : ""}${buildId ? ` build ${buildId}` : ""}`);
}

const repoRoot = () => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return process.cwd(); }
};

const contextFile = (root = repoRoot()) => contextFileFor(root, LEGACY_CONTEXT_FILE);

// One selector for every command that binds a contract, including the API
// map, so `show` and `map`/`view` can never bind different contracts.
const findContract = (root, cfg = resolveConfig(root)) =>
  selectContractFile(root, cfg, () => loadContext(root)?.api?.contract);

/**
 * What to do about a MISSING knowledge file — which is not one answer, because
 * it is not one situation.
 *
 * A repo that serves an API just has not run `init` yet, and "run init" is the
 * whole story. A CONSUMER repo (half of a real personal tree) has nothing of
 * its own to inventory, so `init` answers CONTRACT_NOT_FOUND and the reader is
 * two dead-ended commands deep, having been told by `connect` that the write
 * convention would accumulate. The path that actually works there is naming
 * the spec of an API the repo CALLS — walked end to end, it produces a
 * knowledge file, `note` lands, and doctor's wiring check goes green.
 */
const initHint = (root) => (findContract(root)
  ? `Run: ${CLI_NAME} init`
  : `This repo serves no API of its own, so ${CLI_NAME} init has nothing to inventory. ` +
    `Point API_CONTRACT at the spec of an API it CALLS: ` +
    `API_CONTRACT=<vendor-openapi.json> ${CLI_NAME} init --agents`);

function noteContextHint(root) {
  const commands = advertisementPlan(root);
  const cli = commands.portable.available ? commands.portable.command : commands.local.command;
  const scope = currentStackScope();
  if (scope) return findContract(root)
    ? `Run ${cli} init --stack ${scope.stack}, then retry the note with --stack ${scope.stack}.`
    : `Restore ${contextFile(root)} from version control or a backup, then retry the note with --stack ${scope.stack}. Do not replace the existing stack to repair its missing knowledge file.`;
  if (!hasLegacyStack(root) && !stackCatalog(root).stacks.length)
    return `Create an API knowledge store with ${cli} stack add <name> --base-url <url>, then retry the note with --stack <name>. An OpenAPI contract is optional; add --contract <path> if one is available.`;
  return initHint(root);
}

const die = (code, message, next) => {
  if (code.startsWith("NOTE_HISTORY_"))
    noteRefusal({ error: { code, message, ...(next ? { next } : {}) } });
  // Stack/config selection can fail before the note handler runs. Preserve the
  // same machine-readable stdout contract for those --json invocations too.
  if (process.argv[2] === "note" && process.argv.includes("--json"))
    noteArgumentError(code, message, next);
  console.error(JSON.stringify({ error: { code, message, ...(next ? { next } : {}) } }, null, 1));
  process.exit(1);
};

// Request commands share one strict selector. Keeping it outside individual
// handlers prevents `--env tunnel` from becoming an audit target or suite name
// in one command while working in another. Unknown flags are refused before
// config resolution or traffic; an ignored execution flag is a wrong-target
// success, which is worse than a named failure.
function requestArgs(argv, command, { booleans = [], values = [], equals = [], dashValues = [], redactedUnknown = false } = {}) {
  const booleanSet = new Set(booleans), valueSet = new Set(values), equalsSet = new Set(equals);
  const dashValueSet = new Set(dashValues);
  const unknownFlagMessage = value => redactedUnknown
    ? `Unrecognized ${command} flag; its value is not displayed.`
    : `Unknown ${command} flag '${value}'.`;
  const args = [];
  let environment;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--env") {
      const selected = argv[i + 1];
      if (selected === undefined || selected.startsWith("-"))
        die("ENVIRONMENT_REQUIRED", "--env needs a named environment.",
          `Use: ${CLI_NAME} ${command} --env <name>`);
      if (environment !== undefined)
        die("ENVIRONMENT_DUPLICATE", "--env may be specified only once.",
          `Choose one environment for this ${command} run.`);
      environment = selected; i += 1; continue;
    }
    if (value.startsWith("--env=")) {
      const selected = value.slice("--env=".length);
      if (!selected)
        die("ENVIRONMENT_REQUIRED", "--env needs a named environment.",
          `Use: ${CLI_NAME} ${command} --env <name>`);
      if (environment !== undefined)
        die("ENVIRONMENT_DUPLICATE", "--env may be specified only once.",
          `Choose one environment for this ${command} run.`);
      environment = selected; continue;
    }
    if (!value.startsWith("-") || value === "-") { args.push(value); continue; }
    if (!value.startsWith("--"))
      die("UNKNOWN_FLAG", unknownFlagMessage(value),
        `Run: ${CLI_NAME} ${command} --help`);
    const [flag] = value.split("=", 1);
    if (booleanSet.has(value) || (value.includes("=") && equalsSet.has(flag))) {
      args.push(value); continue;
    }
    if (valueSet.has(value)) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && (!dashValueSet.has(value) || next.startsWith("--")))) {
        args.push(value); continue; // the handler owns its established named missing-value error
      }
      args.push(value, next); i += 1; continue;
    }
    die("UNKNOWN_FLAG", unknownFlagMessage(value),
      `Run: ${CLI_NAME} ${command} --help`);
  }
  return { args, environment };
}

function selectRequestConfig(root, environment) {
  const cfg = resolveConfig(root, { environment });
  if (cfg.problems.length) die(cfg.problems[0].code, cfg.problems[0].message, cfg.problems[0].next);
  // lib/client.mjs resolves once at lazy import. Carry the already-validated
  // explicit selection across that boundary; it still outranks any ambient
  // API_ENV, while API_BASE_URL retains its documented URL override.
  if (environment !== undefined && !currentStackScope()) process.env.API_ENV = environment;
  return cfg;
}

function requestTarget(cfg) {
  return {
    environment: cfg.name ?? null,
    base_url: cfg.baseUrl,
    base_url_source: cfg.baseUrlOverride ? "API_BASE_URL"
      : cfg.baseUrlSource === "config" ? "environment" : cfg.baseUrlSource,
  };
}

function requestTargetLine(cfg) {
  const target = requestTarget(cfg);
  return `environment '${target.environment ?? "unnamed"}' — ${target.base_url}` +
    (target.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : "");
}

// JSON request files are explicit inputs, not executable scripts. Keep parser
// failures value-free because the file may contain transient request arguments.
function commandJsonInput(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      die("JSON_INPUT_LIMIT", "Input must be a regular JSON file no larger than 1 MiB.", "Use a bounded JSON object as the command input.");
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > 1024 * 1024)
      die("JSON_INPUT_LIMIT", "Input exceeds the 1 MiB bound.", "Use a bounded JSON object as the command input.");
    const input = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input))
      die("JSON_INPUT_INVALID", "Input must be a JSON object.", "See docs/protocols.md for request and context examples.");
    return input;
  } catch {
    die("JSON_INPUT_INVALID", "The input JSON file could not be read or parsed.", "Check the input file and its JSON syntax.");
  }
}

async function cmdProtocol(argv) {
  const { args, environment } = requestArgs(argv.slice(1), "protocol");
  if (args.length !== 1)
    die("PROTOCOL_INPUT_REQUIRED", "Provide one JSON request file.", `Use: ${CLI_NAME} protocol request.json [--env <name>]`);
  const input = commandJsonInput(args[0]);
  const requests = Object.hasOwn(input, "requests") ? input.requests : [input];
  const cleanup = Array.isArray(input.finally) ? input.finally : [];
  if (!Array.isArray(requests) || !requests.length || [...requests, ...cleanup].some(request => !request || typeof request !== "object" || typeof request.protocol !== "string"))
    die("PROTOCOL_REQUIRED", "Each protocol request must name its protocol.", "Use http, graphql, jsonrpc, grpc or websocket; see docs/protocols.md.");
  const cliScope = currentStackScope();
  if (cliScope && input.stack !== undefined && input.stack !== cliScope.stack)
    die('STACK_SELECTOR_CONFLICT', 'The JSON stack differs from the explicit --stack selection.',
      'Use one stack selection, or make the CLI and JSON selections agree.');
  // As for MCP, let the request resolver admit each declared stack before any
  // traffic. A multi-stack envelope needs no unrelated repository default.
  if (!stackCatalog(repoRoot()).stacks.length && !isBuiltinStack(input.stack))
    selectRequestConfig(repoRoot(), environment ?? input.environment);
  if (environment !== undefined) input.environment = environment;
  const { apiRequest, runEnvelope, transportError } = await import("../lib/client.mjs");
  let result;
  try { result = Object.hasOwn(input, "requests") ? await runEnvelope(input, { initiator: "cli.protocol" }) : await apiRequest(input, { initiator: "cli.protocol" }); }
  catch (error) { result = { ok: false, error: transportError(error), attempted: error.requestAttempts ?? 0 }; }
  console.log(JSON.stringify(result, null, 1));
  process.exitCode = result.ok ? 0 : 1;
}

function cmdContext(argv) {
  const [, action, file, ...extra] = argv;
  if (action === "query" && file === "--onboarding" && (!extra.length || extra.length === 1 && extra[0] === "--human")) {
    try {
      const receipt = queryDoctorObservation(repoRoot());
      console.log(extra.length ? renderDoctorObservation(receipt) : JSON.stringify(receipt, null, 1));
    }
    catch (error) { die(error.code?.startsWith("ONBOARDING_") ? error.code : "ONBOARDING_OBSERVATION_INVALID",
      "The saved onboarding observation is unavailable or damaged.", "Review the local onboarding evidence; retrieval never sends a request."); }
    return;
  }
  if (action === "keys") {
    // Backfill path-key sources from local evidence: no input file, no requests.
    const flags = argv.slice(2);
    if (flags.some(flag => !["--dry-run", "--json"].includes(flag)))
      die("CONTEXT_ARGUMENTS_INVALID", "context keys accepts only --dry-run and --json.", `Use: ${CLI_NAME} context keys [--dry-run] [--json]`);
    const root = repoRoot();
    let report;
    try { report = backfillKeySources(root, { evidenceDir: evidenceDirectory(root), dryRun: flags.includes("--dry-run"),
      contracts: configuredHttpContracts(root) }); }
    catch (error) {
      const publicError = contextCommandError(error);
      die(publicError.code, publicError.message, publicError.next);
    }
    console.log(flags.includes("--json") ? JSON.stringify(report, null, 1) : renderKeySourceReport(report));
    return;
  }
  const commands = { capture: captureOperationContext, query: queryOperationContext, migrate: migrateOperationContext };
  if (action && !Object.hasOwn(commands, action))
    die("CONTEXT_ACTION_UNKNOWN", "The context action is not supported.", `Use: ${CLI_NAME} context <capture|query|migrate> input.json, or ${CLI_NAME} context keys`);
  if (!action || !file || extra.length)
    die("CONTEXT_ARGUMENTS_REQUIRED", "Provide a context action and one JSON input file.", `Use: ${CLI_NAME} context <capture|query|migrate> input.json`);
  const input = commandJsonInput(file);
  let result;
  try { result = commands[action](repoRoot(), input); }
  catch (error) {
    const publicError = contextCommandError(error);
    die(publicError.code, publicError.message, publicError.next);
  }
  console.log(JSON.stringify(result, null, 1));
  process.exitCode = result.issues?.length ? 1 : 0;
}

function usableRequestConfig(cfg) {
  return cfg && !cfg.problems?.length && typeof cfg.baseUrl === "string";
}

// An explicit environment on a tree belongs to its request-producing
// surfaces, not necessarily the survey root. Validate ALL of them before the
// first auditSurface call so a missing environment cannot turn into a partial
// check whose output quietly omits the service it skipped.
function preflightSurfaceEnvironment(surfaces, environment) {
  if (environment === undefined) return [];
  const rows = [];
  for (const surface of surfaces) {
    const cfg = resolveConfig(surface.dir, { environment });
    if (cfg.problems.length)
      die(cfg.problems[0].code,
        `${surface.name ?? surface.dir}: ${cfg.problems[0].message}`,
        cfg.problems[0].next);
    rows.push({ surface, cfg });
  }
  // auditSurface/client resolve their config later. Preserve the explicit,
  // already-validated choice across that boundary without inventing a root
  // config for a multi-service survey container.
  process.env.API_ENV = environment;
  return rows;
}

function executedRequestTargets(results) {
  const rows = (results ?? []).filter(({ base, attempted }) =>
    typeof base === "string" && attempted > 0).map((result) => ({
    service: result.name,
    environment: result.environment ?? null,
    base_url: result.base,
    base_url_source: result.base_url_source ?? "environment",
  }));
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    return seen.has(key) ? false : seen.add(key);
  });
}

function requestTargetFields(targets) {
  const exact = targets.map(({ service: _service, ...target }) => target);
  const unique = [...new Map(exact.map((target) => [JSON.stringify(target), target])).values()];
  return {
    ...(unique.length === 1 ? { request_target: unique[0] } : {}),
    request_targets: targets,
  };
}

function configuredSurfaceTargets(surfaces, preflightRows = []) {
  const rows = preflightRows.length ? preflightRows
    : surfaces.map((surface) => ({ surface, cfg: resolveConfig(surface.dir) }));
  return rows.filter(({ cfg }) => usableRequestConfig(cfg)).map(({ surface, cfg }) => ({
    service: surface.name ?? basename(surface.dir), ...requestTarget(cfg),
  }));
}

function selectedRequestTargetFields(targets) {
  if (!targets.length) return { request_execution: false };
  if (targets.length === 1) {
    const { service: _service, ...target } = targets[0];
    return { selected_request_target: target, request_execution: false };
  }
  return { selected_request_targets: targets, request_execution: false };
}

function requestEvidenceFields(results, selectedTargets) {
  const attempted = executedRequestTargets(results);
  return attempted.length ? requestTargetFields(attempted)
    : selectedRequestTargetFields(selectedTargets);
}

// --- init ------------------------------------------------------------------

// The inventory itself, as a value: either { error } or the written context.
// Extracted from cmdInit because `connect` needs it too — a connect that wires
// a pointer block into CLAUDE.md pointing at a knowledge file that does not
// exist has installed a promise, not a product. Two copies of this loop would
// drift the day one of them learns something.
function inventoryContext(root, { write = true, contractPath = findContract(root) } = {}) {
  if (!contractPath)
    return { error: { code: "CONTRACT_NOT_FOUND",
      message: `No OpenAPI document found in ${root}.`,
      next: emptyContractDiscoveryNext({ stack: Boolean(currentStackScope()) }) } };

  // A stranger's spec must load or fail with a NAMED reason — a silent
  // "0 operations" cost a week on a normal inline-flow document.
  let contract;
  try { contract = readContract(contractPath); }
  catch (e) {
    return { error: { code: "PARSE_ERROR", message: `${contractPath} could not be parsed: ${e.message}`,
      next: "Fix the document, or point API_CONTRACT at a valid OpenAPI/Swagger file." } };
  }
  const { doc, digest } = contract;
  const skippedRoutes = [];
  const ops = operationsFrom(doc, { onSkipped: item => skippedRoutes.push(item) });
  for (const item of skippedRoutes)
    console.error(`${item.code}: ${item.path} (${item.methods.join(', ')}): ${item.reason}; skipped during contract inventory.`);
  if (!ops.length)
    return { error: { code: "NO_OPERATIONS",
      message: `${contractPath} declares no operations: ${noOperationsReason(doc)}.`,
      next: "Fix the document, or point API_CONTRACT at a valid OpenAPI/Swagger file." } };

  const existing = loadContext(root);
  if (existing?.api?.contract && resolve(root, existing.api.contract) !== resolve(contractPath))
    return { error: { code: "CONTRACT_SELECTION_CONFLICT",
      message: `${contextFile()} belongs to a different OpenAPI contract; setup will not mix their operation knowledge.`,
      next: "Use the original contract for this knowledge file, or set up the other API in a separate repository." } };
  const ctx = existing ?? emptyContext({
    name: doc.info?.title ?? root.split("/").pop(),
    contractPath: contractPath.replace(`${root}/`, ""),
    contractDigest: digest,
  });
  // MCP inspection can create the store before an HTTP contract exists. Attach
  // the first discovered contract while retaining both knowledge collections.
  ctx.api.contract ??= contractPath.replace(`${root}/`, "");
  ctx.api.contract_digest = digest;
  delete ctx.inventory;

  // Bound the planned file before any setup write. Existing authored or
  // observed knowledge is never evicted to make room for a new inventory.
  let contextBytes = Buffer.byteLength(`${JSON.stringify(ctx, null, 2)}\n`);
  if (contextBytes > MAX_CONTEXT_BYTES)
    return { error: { code: "CONTEXT_CAPACITY_REACHED",
      message: "The context exceeds the 16 MiB storage limit; setup left it untouched.",
      next: "Reduce the existing knowledge file before running setup again." } };

  const sources = mapSourceFiles(root);
  let added = 0, omitted = 0;
  let hasOperations = Object.keys(ctx.operations).length > 0;
  for (const { op, path } of ops) {
    if (ctx.operations[op]) continue;
    const entry = baselineNoteHistory({
      source_file: sourceFileFor(path, sources),
      verified_at: null,
      contract_digest: null,
      shape_hash: null,
      status_codes: [],
      effect: op.startsWith("GET ") || op.startsWith("HEAD ") ? "read" : "write",
      fields: {},
    });
    // Account for UTF-8, pretty-print indentation and punctuation in linear
    // time. The small reserve covers the omission receipt, including counts.
    const serialized = JSON.stringify({ [op]: entry }, null, 2);
    const entryBytes = Buffer.byteLength(serialized) + 2 * (serialized.split("\n").length - 2)
      - (hasOperations ? 2 : 0);
    if (contextBytes + entryBytes > MAX_CONTEXT_BYTES - 512) { omitted += 1; continue; }
    ctx.operations[op] = entry;
    hasOperations = true;
    contextBytes += entryBytes;
    added += 1;
  }
  if (omitted) ctx.inventory = { contract_operations: ops.length,
    retained_operations: ops.length - omitted, omitted_operations: omitted,
    reason: "CONTEXT_CAPACITY_REACHED" };
  else delete ctx.inventory;
  // Existing knowledge may already consume the omission reserve. Validate
  // the exact final bytes before connect can write any other planned surface.
  if (Buffer.byteLength(`${JSON.stringify(ctx, null, 2)}\n`) > MAX_CONTEXT_BYTES)
    return { error: { code: "CONTEXT_CAPACITY_REACHED",
      message: "The context exceeds the 16 MiB storage limit; setup left it untouched.",
      next: "Reduce the existing knowledge file before running setup again." } };
  if (write) saveContext(root, ctx);
  const mapped = Object.values(ctx.operations).filter((e) => e.source_file).length;
  return { ctx, contractPath, digest, added, mapped, skippedRoutes };
}

const optionValue = (args, flag) => {
  const hits = args.flatMap((value, i) => value === flag ? [args[i + 1]] : value.startsWith(`${flag}=`) ? [value.slice(flag.length + 1)] : []);
  if (flag === '--env') {
    if (hits.length > 1) die('ENVIRONMENT_DUPLICATE', 'Provide --env only once.');
    if (hits.some(value => !value || value.startsWith('-'))) die('ENVIRONMENT_REQUIRED', 'Provide an environment name after --env.');
  } else if (hits.length > 1 || hits.some(value => !value || value.startsWith('--')))
    die('STACK_ARGUMENT_INVALID', `Provide ${flag} once with a value.`);
  return hits[0];
};
const hasLegacyStack = root => process.env.API_CONFIG !== undefined || existsSync(join(root, LEGACY_CONTEXT_FILE)) || existsSync(join(root, LAYOUT.environments));
function firstStack(root, { name, contract, baseUrl: explicitBaseUrl, auth: explicitAuth, environment: explicitEnvironment }) {
  let doc;
  if (!existsSync(contract) || !statSync(contract).isFile()) die("CONTRACT_NOT_FOUND", "The selected OpenAPI contract is missing or is not a regular file.");
  try { doc = readContract(contract).doc; }
  catch { die('CONTRACT_INVALID', 'The selected OpenAPI document could not be parsed.'); }
  const cfg = resolveConfig(root);
  if (cfg.problems.length) die(cfg.problems[0].code, cfg.problems[0].message, cfg.problems[0].next);
  if (!operationsFrom(doc).length) die('NO_OPERATIONS', 'The selected contract declares no supported operations; setup has not written any files.');
  const title = doc.info?.title ?? basename(root);
  name ??= stackNameFromTitle(title);
  if (explicitBaseUrl) return createStack(root, name, { title, contract, baseUrl: explicitBaseUrl,
    ...(explicitAuth ? { auth: explicitAuth } : {}), ...(explicitEnvironment ? { environment: explicitEnvironment } : {}) });
  const baseUrl = cfg.baseUrlSource !== 'fallback' ? cfg.baseUrl
    : doc.servers?.find(server => typeof server.url === 'string' && /^https?:\/\//u.test(server.url))?.url;
  return createStack(root, name, { title, contract, ...(baseUrl ? { baseUrl, auth: cfg.auth, environment: cfg.name ?? "default", production: cfg.production } : {}) });
}
function cmdStack(argv) {
  if (argv[1] !== 'add') die('STACK_ARGUMENT_INVALID', `Use ${CLI_NAME} stack add <name> --base-url <url>.`);
  const name = argv[2];
  const allowed = ['--base-url', '--auth', '--contract', '--env', '--title'];
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--json') continue;
    if (!allowed.some(flag => argv[i] === flag || argv[i].startsWith(`${flag}=`)))
      die('STACK_ARGUMENT_INVALID', 'Unknown stack option; its value is not displayed.');
    if (!argv[i].includes('=')) i++;
  }
  const root = repoRoot();
  const baseUrl = optionValue(argv, '--base-url');
  if (!baseUrl) die('STACK_URL_REQUIRED', '--base-url is required when adding an API stack.');
  const created = createStack(root, name, { baseUrl,
    auth: optionValue(argv, '--auth'), contract: optionValue(argv, '--contract'),
    environment: optionValue(argv, '--env'), title: optionValue(argv, '--title') });
  withStackScope(created.scope, () => {
    if (created.scope.config.contract) {
      const inventory = inventoryContext(root, { contractPath: created.scope.config.contract });
      if (inventory.error) die(inventory.error.code, inventory.error.message, inventory.error.next);
    } else saveContext(root, emptyContext({ name: created.document.title, contractPath: null, contractDigest: null }));
  });
  const report = { stack: created.stack, wrote: created.stackFile, context: created.contextFile, files: created.created };
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : `${created.stack}: ${created.stackFile}\nKnowledge: ${created.contextFile}`);
}
function cmdStacks(argv) {
  if (argv.some((value, i) => i && value !== '--json')) die('STACK_ARGUMENT_INVALID', `Use ${CLI_NAME} stacks [--json].`);
  const root = repoRoot(), catalog = stackCatalog(root, { includeBuiltin: true });
  const stacks = catalog.problems.length ? catalog.stacks.map(row => ({ name: row.name,
    environments: Object.keys(row.document.environments), contract: { state: 'unavailable' }, counts: null }))
    : catalog.stacks.map(row => withStackScope(stackScope(root, { stack: row.name }), () => {
    const ctx = loadContext(root), records = Object.values(ctx?.api_context?.operations ?? {});
    const cfg = resolveConfig(root);
    const confidence = stackEvidenceClasses(root, ctx ?? {}, { config: cfg, commits: false });
    return { name: row.name, environments: Object.keys(row.document.environments),
      contract: { state: cfg.contract ? (existsSync(cfg.contract) ? 'bound' : 'missing') : 'not_bound',
        ...(cfg.contract ? { path: relative(root, cfg.contract) } : {}) },
      counts: { operations: confidence.operations.size, evidence_classes: confidence.counts,
        observations: records.reduce((n, entry) => n + (entry.observations?.length ?? 0), 0),
        notes: Object.values(ctx?.operations ?? {}).reduce((n, entry) => n + activeNotes(entry).length, 0) } };
  }));
  const report = { stacks, ...(catalog.defaults?.default_stack ? { default_stack: catalog.defaults.default_stack } : {}),
    ...(catalog.problems.length ? { problems: catalog.problems } : {}) };
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : [
    ...stacks.map(row => `${row.name}: ${row.environments.join(', ') || 'no environments'}; contract ${row.contract.state}; `
      + (row.counts ? `${row.counts.operations} operations; ${formatEvidenceClassCounts(row.counts.evidence_classes)}; ${row.counts.observations} observations, ${row.counts.notes} notes` : 'counts unavailable')),
    ...catalog.problems.map(problem => `${problem.code}: ${problem.message}`),
  ].join('\n') || 'No explicit stacks; existing installations use their legacy configuration.');
  if (catalog.problems.length) process.exitCode = 1;
}

function cmdInit(argv) {
  const root = repoRoot();
  const contractArg = optionValue(argv, '--contract');
  const explicitStack = optionValue(argv, '--stack');
  const contract = contractArg ? resolve(root, contractArg) : currentStackScope()?.config.contract ?? findContract(root);
  if (!currentStackScope() && !hasLegacyStack(root) && !stackCatalog(root).stacks.length && contract) {
    const preview = inventoryContext(root, { write: false, contractPath: contract });
    if (preview.error) die(preview.error.code, preview.error.message, preview.error.next);
    const commands = advertisementPlan(root);
    const pointers = argv.includes('--agents') ? planPointers(root, preview.ctx, commands) : [];
    const conflict = pointers.find(row => row.action === 'conflict');
    if (conflict) die('POINTER_CONFLICT', `${conflict.file}: ${conflict.reason}`, 'Repair the managed pointer before retrying setup; nothing was written.');
    const name = explicitStack ?? stackNameFromTitle(preview.ctx.api.name ?? basename(root));
    const folder = join(root, LAYOUT.collection, name);
    const paths = [...planLayout(root).files.map(row => join(root, row.path)),
      join(folder, 'stack.json'), join(folder, basename(LEGACY_CONTEXT_FILE)), join(folder, basename(contract)),
      ...pointers.filter(row => row.action !== 'unchanged').map(row => row.path)];
    const unwritable = paths.map(path => ({ path, problem: writableDestinationProblem(path) })).find(row => row.problem);
    if (unwritable) die('WRITE_PLAN_CONFLICT', `${relative(root, unwritable.path)}: ${unwritable.problem}; nothing was written.`);
    const created = firstStack(root, { name: explicitStack, contract });
    return withStackScope(created.scope, () => cmdInit(["init", ...(argv.includes("--agents") ? ["--agents"] : []), "--contract", created.scope.config.contract]));
  }
  // Resolve the complete committed-command tier before inventoryContext can
  // write the knowledge file. A partial advertisement is valid; discovering it
  // after the first write would not be a plan.
  const commandResolution = advertisementPlan(root);
  const r = inventoryContext(root, { write: false, ...(contract ? { contractPath: contract } : {}) });
  if (r.error) die(r.error.code, r.error.message, r.error.next);
  const { ctx, digest, added, mapped } = r;
  const pointerPlans = argv.includes("--agents")
    ? planPointers(root, ctx, commandResolution) : [];
  const conflict = pointerPlans.find(({ action }) => action === "conflict");
  if (conflict) die("POINTER_CONFLICT", `${conflict.file}: ${conflict.reason}`,
    `Repair the managed pointer file, then re-run ${commandResolution.local.command} init --agents.`);
  const pending = [
    ...planLayout(root).files.map(row => ({ surface: row.path, path: join(root, row.path) })),
    { surface: contextFile(), path: join(root, contextFile()) },
    ...pointerPlans.filter(({ action }) => !["unchanged", "conflict"].includes(action))
      .map(({ file, path }) => ({ surface: file, path })),
  ];
  const unwritable = pending.map((row) => ({ ...row,
    problem: writableDestinationProblem(row.path) })).find(({ problem }) => problem);
  if (unwritable) die("WRITE_PLAN_CONFLICT",
    `${unwritable.surface}: ${unwritable.problem}; nothing was written.`,
    `Make that project target writable, then re-run ${commandResolution.local.command} init --agents.`);
  saveContext(root, ctx);
  const pointers = applyPointerPlans(pointerPlans);
  const omitted = argv.includes("--agents")
    ? pointerOmissions(commandResolution, POINTER_FILES) : [];

  console.log(JSON.stringify({
    wrote: join(root, contextFile()),
    contract: ctx.api.contract, contract_digest: digest,
    operations: Object.keys(ctx.operations).length, added,
    ...(r.skippedRoutes.length ? { skipped_routes: r.skippedRoutes } : {}),
    source_mapped: `${mapped}/${Object.keys(ctx.operations).length}`,
    pointers_written: pointers,
    omitted,
    command_resolution: publicCommandResolution(commandResolution),
    next: `${CLI_NAME} learn — execute safe reads and record what is actually true.`,
  }, null, 1));
}

// Pointer blocks.
//
// AGENTS.md is the canonical instruction file. Existing CLAUDE.md files get
// the same managed block; a new one is only an import bridge for older hosts.
//
// The split inside the block matters as much as the location. An agent will look
// up an enum when it needs one; it will never look up "is anything weird about
// this endpoint", because it does not know to ask. So gotchas are PUSHED into
// the auto-loaded file, and everything else is PULLED from sannr.json when
// there is an actual question.
// POINTER_FILES is owned by lib/capabilities.mjs and imported above, so the
// capabilities manifest and the code that writes these blocks name the SAME set.
// The delimiters come from lib/brand.mjs, not from a literal here: unwire finds
// a block written by an OLDER install by matching these exact strings, so they
// are a contract with files already in a user's repo and must move as one.
const BEGIN = POINTER_BEGIN;
const END = POINTER_END;
function publicCommandResolution(plan) {
  return {
    mcp: { server: plan.mcp.server, tool: plan.mcp.tool, advertised: true,
      meaning: "Registration target only; host activation requires a matching setup binding in the loaded tool description." },
    portable: {
      command: plan.portable.command, available: plan.portable.available,
      ...(plan.portable.reason ? { reason: plan.portable.reason } : {}),
      ...(plan.portable.remedy ? { remedy: plan.portable.remedy } : {}),
    },
    local: { command: plan.local.command, available: true },
    shadowing: plan.shadowing,
  };
}

function pointerOmissions(plan, files) {
  return plan.portable.available ? [] : files.map((file) => commandOmission(file, plan));
}

function applyPointerPlans(plans) {
  for (const plan of plans)
    if (plan.action !== "unchanged" && plan.action !== "conflict")
      writeFileSync(plan.path, plan.text);
  return plans.map(({ file, action }) => ({ file, action }));
}

function runtimePointerRepairs(root, bindingId) {
  return POINTER_FILES.flatMap(file => {
    const path = join(root, file);
    const unsafe = pointerPathProblem(root, path);
    if (unsafe) return [{ path, action: 'refused', reason: `${file}: ${unsafe}` }];
    if (!existsSync(path)) return [];
    const before = readFileSync(path, 'utf8');
    const begins = before.split(BEGIN).length - 1, ends = before.split(END).length - 1;
    if (!begins && !ends) return [];
    const start = before.indexOf(BEGIN), finish = before.indexOf(END) + END.length;
    if (begins !== 1 || ends !== 1 || finish <= start)
      return [{ path, action: 'refused', reason: `${file}: malformed managed pointer delimiters` }];
    const block = before.slice(start, finish);
    const marker = /^Expected tool description marker: Setup binding: setup-v1:[a-f0-9]{64}$/gm;
    if ([...block.matchAll(marker)].length !== 1)
      return [{ path, action: 'refused', reason: `${file}: missing or edited setup marker; run connect to regenerate guidance` }];
    const updated = block.replace(marker, `Expected tool description marker: Setup binding: ${bindingId}`);
    const text = before.slice(0, start) + updated + before.slice(finish);
    return text === before ? [] : [{ path, action: 'repair', text }];
  });
}

function wirePointers(root, ctx, commandResolution = advertisementPlan(root)) {
  const plans = planPointers(root, ctx, commandResolution);
  const conflict = plans.find(({ action }) => action === "conflict");
  if (conflict) {
    const error = new Error(`${conflict.file}: ${conflict.reason}`);
    error.code = "POINTER_CONFLICT";
    throw error;
  }
  return applyPointerPlans(plans);
}

function unwirePointers(root) {
  const rows = [];
  for (const name of POINTER_FILES) {
    const p = join(root, name);
    try { lstatSync(p); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    const unsafe = pointerPathProblem(root, p);
    if (unsafe) {
      rows.push({ file: name, action: "left", reason: unsafe });
      continue;
    }
    const text = readFileSync(p, "utf8");
    const begins = text.split(BEGIN).length - 1, ends = text.split(END).length - 1;
    if (!begins && !ends) continue;
    if (begins !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(BEGIN)) {
      rows.push({ file: name, action: "left", reason: "managed pointer delimiters are malformed" });
      continue;
    }
    const start = text.indexOf(BEGIN), finish = text.indexOf(END, start) + END.length;
    const before = text.slice(0, start), after = text.slice(finish);
    // Remove the default empty wrapper, never an arbitrary user heading or
    // whitespace outside our markers. Those neighboring bytes are not ours.
    const generatedHeader = `# ${name.replace(/\.md$/, "")}\n\n`;
    writeFileSync(p, before === generatedHeader && /^\s*$/.test(after)
      ? "" : before + after);
    rows.push({ file: name, action: "removed" });
  }
  return rows;
}

// --- connect / unwire ------------------------------------------------------
//
// The adoption mechanic. Measured: a frontier agent does not adopt this tool
// mid-task on its own, but it honours a convention a HUMAN wired in — so the
// wiring is the product's front door, and every hand-edit on the way in is a
// place a tester fails and blames us. One command does all four halves:
//
//   1. the MCP registration      (so the agent can call it at all)
//   2. the skills                (so it knows WHEN — and the write convention,
//                                 which is the whole accumulation mechanism)
//   3. the pointer block         (measured: the auto-loaded file is what lands)
//   4. the knowledge file        (so 3 points at something that exists)
//
// Idempotent by planning against the file on disk and writing only real
// changes; reversible by `unwire`, which removes exactly what it recognises as
// ours and nothing else.

const rel = (root, p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);

async function cmdMigrate(argv) {
  const options = { splits: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (['--json', '--dry-run'].includes(arg)) continue;
    const match = /^(--name|--split)(?:=(.*))?$/.exec(arg);
    if (!match) die('MIGRATION_ARGUMENT_INVALID', 'Migration accepts --name, --split, --json and --dry-run.', `${CLI_NAME} migrate --help`);
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--')) die('MIGRATION_ARGUMENT_INVALID', `${match[1]} needs a value.`, `${CLI_NAME} migrate --help`);
    if (match[1] === '--split') options.splits.push(value);
    else {
      if (options.name !== undefined) die('MIGRATION_ARGUMENT_INVALID', '--name may be given once.', `${CLI_NAME} migrate --help`);
      options.name = value;
    }
  }
  const root = repoRoot(), dryRun = argv.includes('--dry-run');
  const { planStackMigration, applyStackMigration } = await import('../lib/stack-migration.mjs');
  const { mcpTargets, projectPathProblem, writeText, planRemoval, migrateSkillPlans, removeSkill } = await import('../lib/connect.mjs');
  const { migrateCiWorkflowText } = await import('../lib/ci-workflow.mjs');
  let plan;
  try { plan = migrateLayout(root, { dryRun: true }); }
  catch (error) { die(error.code ?? 'MIGRATION_FAILED', error.message,
    'Preserve both files and resolve the named destination conflict before retrying migration.'); }
  let stacksPlan;
  try { stacksPlan = planStackMigration(root, { ...options,
    ...(plan.moved.length ? { virtualFiles: projectedLayoutFiles(root, plan) } : {}) }); }
  catch (error) { die(error.code ?? 'MIGRATION_FAILED', `${error.message}${error.details?.path ? ` (${error.details.path})` : ''}`,
    error.next ?? `Resolve the named migration issue, then run ${CLI_NAME} migrate --dry-run.`); }
  const entries = legacyLayoutEntries(root);
  const priorPaths = plan.previousLayouts.flatMap(prior => {
    const old = layoutFor(prior.product, prior.collection);
    return Object.keys(LAYOUT).map(key => ({ from: old[key], to: LAYOUT[key] }));
  });
  const legacyPaths = entries.some(entry => !entry.product)
    ? Object.entries(LEGACY_LAYOUT).map(([key, from]) => ({ from, to: LAYOUT[key === 'hiddenEnvironments' ? 'environments' : key] })) : [];
  const replacements = [...plan.moved, ...priorPaths, ...entries, ...legacyPaths]
    .filter(row => row.from !== row.to).sort((a, b) => b.from.length - a.from.length);
  const mapping = new Map(replacements.flatMap(({ from, to }) => [
    [join(root, from), join(root, to)], [from, to],
  ]));
  const pattern = mapping.size ? new RegExp([...mapping.keys()]
    .sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const rewrite = value => pattern ? value.replace(pattern, value => mapping.get(value)) : value;
  const writes = [], removals = [];
  const skillPlans = migrateSkillPlans(root, { previousLayouts: plan.previousLayouts });
  const skillConflict = skillPlans.find(row => row.action === 'conflict');
  if (skillConflict) die('MIGRATION_CONFLICT', `${rel(root, skillConflict.to)}: ${skillConflict.reason}`, 'Preserve the edited instructions and resolve this named skill conflict before migrating.');
  for (const row of skillPlans.filter(row => row.action !== 'unchanged')) {
    const problem = writableDestinationProblem(row.to);
    if (problem) die('MIGRATION_CONFLICT', `${rel(root, row.to)}: ${problem}`, 'Make the named skill destination writable before migrating.');
    writes.push({ path: row.to, text: row.body });
    if (row.from !== row.to && !plan.moved.some(move => join(root, move.from) === row.from)) removals.push(row.from);
  }
  function stage(path, transform) {
    const unsafe = projectPathProblem(root, path);
    if (unsafe) die('MIGRATION_CONFLICT', `${rel(root, path)}: ${unsafe}`, 'Repair the named path; migration has written nothing.');
    if (!existsSync(path)) return;
    const before = readFileSync(path, 'utf8'), after = transform(before);
    if (after !== before) {
      const problem = writableDestinationProblem(path);
      if (problem) die('MIGRATION_CONFLICT', `${rel(root, path)}: ${problem}`, 'Make this managed path writable before retrying.');
      writes.push({ path, text: after });
    }
  }
  for (const file of POINTER_FILES) stage(join(root, file), text => {
    let out = text;
    for (const product of new Set([PRODUCT, ...plan.previousProducts])) {
      const begin = `<!-- ${product}:begin -->`, end = `<!-- ${product}:end -->`;
      const begins = out.split(begin).length - 1, ends = out.split(end).length - 1;
      if (!begins && !ends) continue;
      if (begins !== 1 || ends !== 1 || out.indexOf(end) < out.indexOf(begin))
        die('MIGRATION_CONFLICT', `${file}: managed pointer delimiters are malformed`, 'Repair this pointer block before migrating; no files were moved.');
      const start = out.indexOf(begin), finish = out.indexOf(end) + end.length;
      let block = rewrite(out.slice(start, finish)).replace(begin, POINTER_BEGIN).replace(end, POINTER_END);
      if (product !== PRODUCT) block = block.replace(new RegExp(product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), PRODUCT);
      out = out.slice(0, start) + block + out.slice(finish);
    }
    return out;
  });
  for (const target of mcpTargets(root).filter(target => target.writable)) stage(target.file, text => {
    // Registration paths are generated machine-local launch settings. Only
    // this product's owned registration is changed; foreign host keys survive.
    if (planRemoval(text, target)?.action !== 'removed') return text;
    if (target.file.endsWith('.json')) {
      let data; try { data = JSON.parse(text); } catch { return text; }
      const registrations = data[target.shape?.container ?? "mcpServers"];
      const registration = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS]
        .map(key => registrations?.[key]).find(Boolean);
      if (!registration) return text;
      const before = JSON.stringify(registration);
      for (const key of ['API_CONFIG', 'API_EVIDENCE', 'API_CONTEXT_DIR'])
        if (typeof registration.env?.[key] === 'string') registration.env[key] = rewrite(registration.env[key]);
      return JSON.stringify(registration) === before ? text : JSON.stringify(data, null, 2) + '\n';
    }
    // TOML tables delimit the owned server and its environment subsection.
    const lines = text.split('\n'); let owned = false;
    return lines.map(line => {
      if (/^\s*\[/.test(line)) owned = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS]
        .some(key => line.includes(`mcp_servers.${key}`) || line.includes(`mcp_servers."${key}"`));
      return owned && /(?:API_CONFIG|API_EVIDENCE|API_CONTEXT_DIR)/.test(line) ? rewrite(line) : line;
    }).join('\n');
  });
  const workflow = join(root, '.github', 'workflows', CI_WORKFLOW_BASENAME);
  for (const product of new Set([PRODUCT, ...plan.previousProducts])) {
    const oldWorkflow = join(root, '.github', 'workflows', CI_WORKFLOW_BASENAME.replace(PRODUCT, product));
    stage(oldWorkflow, text => {
      const rendered = migrateCiWorkflowText(text, { priorLayouts: plan.previousLayouts });
      if (!rendered) return text;
      if (oldWorkflow !== workflow) {
        const unsafe = projectPathProblem(root, workflow);
        if (unsafe || existsSync(workflow)) die('MIGRATION_CONFLICT', `${rel(root, workflow)}: ${unsafe ?? 'destination already exists'}`, 'Resolve the named workflow conflict before migrating.');
        writes.push({path: workflow, text: rendered}); removals.push(oldWorkflow);
        return text;
      }
      return rendered;
    });
  }
  // Check every core move as well as the supplemental reference/skill writes.
  // Rename/unlink authority belongs to the source parent; generated metadata
  // and obsolete guides must not become a late failure after knowledge moved.
  const layoutWrites = planLayout(root, { migrating: true });
  const destinations = new Set([
    ...writes.map(row => row.path), ...plan.moved.map(row => join(root, row.to)),
    ...layoutWrites.files.filter(row => !existsSync(join(root, row.path))
      || readFileSync(join(root, row.path), 'utf8') !== row.content).map(row => join(root, row.path)),
    ...layoutWrites.directories.filter(path => !existsSync(join(root, path)))
      .map(path => join(root, path, '.migration-directory-check')),
  ]);
  const oldMetadata = plan.previousLayouts.flatMap(prior => {
    const old = layoutFor(prior.product, prior.collection);
    return [join(root, old.readme), join(root, old.marker)];
  });
  const removedEntries = new Set([...removals,
    ...plan.moved.map(row => join(root, row.from)), ...oldMetadata]);
  for (const path of destinations) {
    const problem = writableDestinationProblem(path);
    if (problem) die('MIGRATION_CONFLICT', `${rel(root, path)}: ${problem}`, 'Make the named destination writable before migrating; no files were moved.');
  }
  for (const path of removedEntries) {
    const problem = writableDestinationProblem(join(dirname(path), '.migration-removal-check'));
    if (problem) die('MIGRATION_CONFLICT', `${rel(root, path)}: ${problem}`, 'Make the old artifact directory writable before migrating; no files were moved.');
  }
  if (!dryRun) {
    try { if (plan.moved.length || plan.previousLayouts.length || stacksPlan.state !== 'noop') migrateLayout(root); }
    catch (error) { die(error.code ?? 'MIGRATION_FAILED', error.message, 'Preserve the named files and inspect the migration conflict.'); }
    for (const row of writes) writeText(row.path, row.text, root);
    for (const path of removals) removeSkill(path, root);
    try {
      // Older root/renamed installs were already included in the complete
      // preflight. Apply only a newly read canonical plan after that move.
      const currentPlan = plan.moved.length ? planStackMigration(root, options) : stacksPlan;
      applyStackMigration(currentPlan);
      if (currentPlan.state !== 'noop') ensureLayout(root);
    } catch (error) { die(error.code ?? 'MIGRATION_FAILED', `${error.message}${error.details?.path ? ` (${error.details.path})` : ''}`,
      `Preserve the named files and inspect ${CLI_NAME} migrate --dry-run before retrying.`); }
  }
  const report = { ...plan, dry_run: dryRun, stacks: stacksPlan.stacks,
    stack_migration: stacksPlan, suggestions: stacksPlan.suggestions, issues: stacksPlan.issues,
    updated: writes.map(row => rel(root, row.path)), requests_executed: 0,
    next: dryRun ? `Review this plan, then run ${CLI_NAME} migrate with the same --name and --split options.`
      : `Run ${CLI_NAME} connect to refresh the repository registration and instructions.` };
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2)
    : `${dryRun ? 'Would migrate' : 'Migrated'} ${plan.moved.length + stacksPlan.moves.length} files into ${LAYOUT.directory}; ${writes.length} managed references updated.\n`
      + [...stacksPlan.suggestions, ...stacksPlan.issues].map(row => `${row.code}: ${row.argument ?? row.operation ?? row.run ?? row.record ?? row.stack}`).join('\n')
      + `\n${report.next}`);
}

async function cmdStackMove(argv) {
  const { moveStackOperation } = await import('../lib/stack-migration.mjs');
  let to, from, operation;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') continue;
    const match = /^(--to|--from)(?:=(.*))?$/.exec(arg);
    if (match) {
      const value = match[2] ?? argv[++i];
      if (!value || value.startsWith('--') || (match[1] === '--to' ? to : from) !== undefined)
        die('STACK_MOVE_ARGUMENT_INVALID', `${match[1]} needs one value.`, `${CLI_NAME} stack move --to <stack> "<METHOD /path>"`);
      if (match[1] === '--to') to = value; else from = value;
    } else if (!arg.startsWith('--') && operation === undefined) operation = arg;
    else die('STACK_MOVE_ARGUMENT_INVALID', 'Name one operation and a destination stack.', `${CLI_NAME} stack move --to <stack> "<METHOD /path>"`);
  }
  if (!to || !operation) die('STACK_MOVE_ARGUMENT_INVALID', 'Name one operation and a destination stack.', `${CLI_NAME} stack move --to <stack> "<METHOD /path>"`);
  assertWritableStack(to); assertWritableStack(from);
  try {
    const report = moveStackOperation(repoRoot(), { to, from, operation });
    console.log(argv.includes('--json') ? JSON.stringify(report, null, 2)
      : `${report.state}: ${operation} → ${to}. Run ${CLI_NAME} connect to refresh managed instructions.`);
  } catch (error) { die(error.code ?? 'STACK_MOVE_FAILED', error.message,
    error.next ?? `Inspect ${CLI_NAME} stacks and name an unambiguous source with --from.`); }
}

async function cmdConnect(argv, { silent = false, selectedContract, createdStackFiles = [], firstStackReport = null } = {}) {
  const { mcpTargets, planTarget, snippetFor, projectEntry, planSkills, writeText,
    credentialReport, missingSkills, SERVER_PATH, projectPathProblem, removeSkill } =
    await import("../lib/connect.mjs");
  const { materializeCiArtifacts, CI_INSTALL_DEFAULT } = await import("../lib/ci-workflow.mjs");
  const { CLAUDE_HOOK_SETTINGS, claudeHookFileProblem,
    claudeHookTarget, configuredBaseUrls,
    planClaudeHook, policyBaseUrl, renderClaudeHookCommand } =
    await import("../lib/claude-hook.mjs");

  const { planClaudeHookIgnore, applyClaudeHookIgnore, claudeHookIgnoreReport } =
    await import("../lib/claude-hook-ignore.mjs");

  const installFlags = argv.filter((arg) => arg === "--install" || arg.startsWith("--install="));
  const switchInstall = argv.includes("--switch-install");
  if ((installFlags.length || switchInstall) && !argv.includes("--ci"))
    die("CI_FLAG_REQUIRED", "--install and --switch-install require connect --ci.",
      "Choose connect --ci --install vendored or connect --ci --install registry.");
  if (installFlags.length > 1 || (switchInstall && !installFlags.length))
    die("CI_INSTALL_INVALID", "Choose exactly one --install mode; --switch-install requires an explicit --install.",
      "Use connect --ci --install <vendored|registry> --switch-install.");
  const installFlag = installFlags[0];
  const install = installFlag?.startsWith("--install=") ? installFlag.slice("--install=".length)
    : installFlag ? argv[argv.indexOf(installFlag) + 1] : CI_INSTALL_DEFAULT;
  if (!["vendored", "registry"].includes(install))
    die("CI_INSTALL_INVALID", "--install must be vendored or registry.",
      "Choose connect --ci --install vendored or connect --ci --install registry.");
  const ciOptions = { install, switchInstall, pathProblem: projectPathProblem };

  const root = repoRoot();
  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");
  // The first stack. --base-url, --auth and --env use stack add's validation
  // and error codes; --stack names the stack. The dispatcher consumes --stack
  // and --env when stacks already exist, so here they only reach a repository
  // that has none. Values are never echoed: a URL may carry a credential.
  const stackFlags = { baseUrl: optionValue(argv, '--base-url'), auth: optionValue(argv, '--auth'),
    environment: optionValue(argv, '--env'), name: optionValue(argv, '--stack') };
  const stackEligible = !firstStackReport && !currentStackScope() && !hasLegacyStack(root) && !stackCatalog(root).stacks.length;
  if (!firstStackReport && stackFlags.baseUrl && !stackEligible) {
    if (hasLegacyStack(root) && !stackCatalog(root).stacks.length)
      die('STACKS_MIGRATION_REQUIRED', 'This repository has a single-store installation; connect --base-url creates a first stack only in a repository without one.', `Run ${CLI_NAME} migrate --dry-run, or connect without --base-url.`);
    die('STACK_EXISTS', 'This repository already has an API stack; connect --base-url only creates the first one. Nothing was written.', `Add another API with ${CLI_NAME} stack add <name> --base-url <url>, or run connect without --base-url.`);
  }
  if (stackEligible && !stackFlags.baseUrl && (stackFlags.auth || stackFlags.environment))
    die('STACK_URL_REQUIRED', '--base-url is required with --auth or --env when connect creates the first API stack.');
  const commandResolution = advertisementPlan(root);
  const localCli = commandResolution.portable.source === "npm-exact-version"
    ? commandResolution.portable.command : commandResolution.local.command;
  const localize = (value) => {
    if (typeof value !== "string") return value;
    let out = value;
    for (const command of ["connect", "init", "learn", "doctor", "map", "unwire"])
      out = out.replaceAll(`${CLI_NAME} ${command}`, `${localCli} ${command}`);
    return out;
  };
  let cfg = resolveConfig(root);
  const unselectedStacks = cfg.problems.length === 1 && cfg.problems[0].code === 'STACK_REQUIRED' && stackCatalog(root).stacks.length > 1;
  if (unselectedStacks) cfg = { ...cfg, problems: [], baseUrl: FALLBACK_BASE_URL,
    baseUrlSource: 'fallback', headers: {}, variables: {}, hosts: {}, credentialEnvFiles: [] };
  // A config that cannot be parsed is not a base to wire onto: the registration
  // would be written, look right, and fail on the first call for a reason the
  // tester cannot see from .mcp.json.
  if (cfg.problems.length) die(cfg.problems[0].code, cfg.problems[0].message, cfg.problems[0].next);
  const contractPlan = unselectedStacks ? { contract: null,
    report: { action: 'unchanged', reason: 'Repository registration; select a stack for API inventory.' } }
    : planSetupContract(root, cfg, { contextContract: loadContext(root)?.api?.contract, selectedContract });
  if (contractPlan.error) die(contractPlan.error.code, contractPlan.error.message, contractPlan.error.next);
  cfg.contract = contractPlan.contract;
  if (contractPlan.file) {
    const unsafe = projectPathProblem(root, contractPlan.file);
    if (unsafe) die("CONFIG_PATH_UNSAFE", `The environment config cannot be updated: ${unsafe}.`,
      "Use an unlinked project-local config path, or declare its contract explicitly before setup.");
  }
  if (cfg.contract && (!existsSync(cfg.contract) || !statSync(cfg.contract).isFile()))
    die("CONTRACT_NOT_FOUND", "The selected OpenAPI contract is missing or is not a file; setup has not written any files.",
      "Restore the configured contract path, or select the correct existing contract with start --contract <path>.");
  const storedContext = inspectContext(root);
  if (!["missing", "healthy"].includes(storedContext.state))
    die("CONTEXT_INVALID", `${contextFile()} is ${storedContext.state}; setup left it untouched.`,
      "Repair the existing knowledge file before running setup again.");

  // The shell-HTTP interception is deliberately opt-in. Its command contains
  // machine-local absolute paths, so it lands in Claude Code's project-local
  // (normally uncommitted) settings, never the shared settings file. Preflight
  // before any ordinary connect write: malformed/linked/edited local policy
  // must not leave a half-wired repo behind.
  const wantsClaudeHook = argv.includes("--claude-hook");
  const hookTarget = claudeHookTarget(root);
  const pinnedBaseUrls = cfg.baseUrlSource === "env"
    ? [policyBaseUrl(cfg.baseUrl)].filter(Boolean) : [];
  const configuredHookUrls = cfg.file && existsSync(cfg.file)
    ? configuredBaseUrls(readFileSync(cfg.file, "utf8"), pinnedBaseUrls)
    : configuredBaseUrls("{}", pinnedBaseUrls);
  const hookCommand = renderClaudeHookCommand({ configPath: cfg.file ?? "",
    doctor: `${localCli} doctor`, pinnedBaseUrls });
  let hookPlan = null;
  let hookIgnorePlan = null;
  if (wantsClaudeHook) {
    if (!configuredHookUrls.length)
      die("CLAUDE_HOOK_NO_CONFIGURED_BASE",
        "The hook has no explicitly configured HTTP(S) base URL to protect.",
        `Set an environment baseUrl in ${LAYOUT.environments} or API_BASE_URL, then re-run connect --claude-hook.`);
    const unsafe = projectPathProblem(root, hookTarget) ?? claudeHookFileProblem(hookTarget);
    if (unsafe) die("CLAUDE_HOOK_PATH_UNSAFE",
      `Claude Code hook settings are unsafe: ${unsafe}.`,
      `Replace the linked/non-file path, then re-run \`${localCli} connect --claude-hook\`.`);
    hookPlan = planClaudeHook(existsSync(hookTarget) ? readFileSync(hookTarget, "utf8") : null,
      hookCommand);
    if (hookPlan.action === "conflict")
      die(hookPlan.code, hookPlan.reason,
        `Review ${CLAUDE_HOOK_SETTINGS}; connect never replaces a locally different hook.`);
    hookIgnorePlan = planClaudeHookIgnore(root);
    if (hookIgnorePlan.action === "conflict")
      die(hookIgnorePlan.code, hookIgnorePlan.reason,
        "Review the repository-local Git exclude; connect never replaces an unsafe or edited ignore rule.");
  }

  // CI planning builds the exact pair and checks both destinations, but writes
  // neither. Materialization happens only after every ordinary connect surface
  // below has also been planned and found conflict-free.
  let ci = null;
  if (argv.includes("--ci")) {
    try { ci = materializeCiArtifacts(root, { ...ciOptions, dryRun: true }); }
    catch (error) {
      const code = error?.code ?? "CI_ARTIFACT_WRITE_FAILED";
      die(code, error?.message ?? "Could not materialize CI artifacts.",
        code === "CI_INSTALL_SWITCH_REQUIRED"
          ? `Use \`${localCli} connect --ci --install ${install} --switch-install\` to change an intact owned installation.`
          : "Leave team-owned files in place; restore the exact generated artifacts before retrying.");
    }
  }

  const hookAction = hookPlan
    ? (dryRun && hookPlan.action !== "unchanged" ? `would_${hookPlan.action}` : hookPlan.action)
    : "not_requested";
  const hooks = {
    claude_code: {
      action: hookAction,
      path: CLAUDE_HOOK_SETTINGS,
      ...(hookIgnorePlan ? { ignore: claudeHookIgnoreReport(hookIgnorePlan, dryRun) } : {}),
      scope: "literal HTTP(S) targets in Bash curl/wget calls to configured repo base URLs; dynamic shell-variable targets, --config/--input-file targets, and scripts piped into another shell are not guessed and remain untouched",
      ...(wantsClaudeHook ? {} : {
        fix: `Opt in explicitly with \`${localCli} connect --claude-hook\`.`,
      }),
    },
    codex: {
      action: "unsupported",
      reason: "Codex has no reliable project-scoped PreToolUse shell-hook surface; none was fabricated.",
      fallback: `MCP registration, skills, and pointer guidance remain available; verify them with \`${localCli} doctor\`.`,
    },
  };

  // Every path the server resolves is pinned absolute here — the config AND the
  // evidence directory — because the host spawns it from its own cwd, not the
  // repo's. Composed in one place (lib/connect.mjs) so doctor's idea of a
  // correct registration is the same object this writes.
  const entry = projectEntry(root, cfg, { configText: contractPlan.text });
  commandResolution.mcp.bindingId = entry.env.API_SETUP_BINDING;

  // 1. MCP registrations.
  const mcpPlans = [];
  let conflicts = 0;
  for (const t of mcpTargets(root)) {
    if (!t.writable) {   // detected, deliberately not written (global / not JSON)
      mcpPlans.push({ target: t, plan: null, public: { host: t.id, label: t.label, file: t.file, action: "manual",
        reason: t.why, snippet: snippetFor(t, entry) } });
      continue;
    }
    const unsafe = projectPathProblem(root, t.file);
    if (unsafe) {
      conflicts += 1;
      mcpPlans.push({ target: t, plan: null, public: { host: t.id, label: t.label, file: rel(root, t.file), action: "conflict",
        reason: `${unsafe}; project MCP paths must not traverse symbolic links.`,
        fix: `Replace the linked path with a real file/directory inside the project, then re-run \`${localCli} connect\`.` } });
      continue;
    }
    const existing = existsSync(t.file) ? readFileSync(t.file, "utf8") : null;
    const plan = planTarget(existing, t, entry);
    if (plan.action === "conflict") conflicts += 1;
    mcpPlans.push({ target: t, plan, public: { host: t.id, label: t.label,
      file: rel(root, t.file), action: plan.action,
      ...(plan.reason ? { reason: localize(plan.reason), fix: localize(plan.fix),
        snippet: snippetFor(t, entry) } : {}) } });
  }
  const mcp = mcpPlans.map(({ public: row }) => row);

  // 2. Plan the knowledge file without writing it. Pointer content depends on
  // this exact planned context, so context + both blocks are one write set.
  let ctx = loadContext(root);
  let context = ctx ? "present" : "skipped";
  let inventoryPlan = null;
  let contextProblem = null;
  if (!argv.includes("--no-pointers")) {
    // The setup plan is authoritative, including a refused or absent contract.
    const r = inventoryContext(root, { write: false, contractPath: cfg.contract });
    if (r.error) {
      // A stack created without a contract already has its knowledge file.
      context = r.error.code === "CONTRACT_NOT_FOUND" && ctx ? "present" : `skipped — ${r.error.message}`; contextProblem = r.error;
      if (r.error.code !== "CONTRACT_NOT_FOUND") conflicts += 1;
    }
    else {
      inventoryPlan = r;
      ctx = r.ctx;
      context = loadContext(root) ? "present" : (dryRun ? "would write" : "wrote");
    }
  }

  // connect is the documented cold-install entrypoint too. Plan its first
  // inventory in the current layout, using the same creator as init/start.
  // Creation stays behind the complete setup conflict/write preflight below.
  const firstStackPlan = inventoryPlan && !currentStackScope() && !hasLegacyStack(root)
    && !stackCatalog(root).stacks.length ? (() => {
      const name = stackFlags.name ?? stackNameFromTitle(inventoryPlan.ctx.api.name ?? basename(root));
      const folder = join(root, LAYOUT.collection, name);
      return { name, contract: cfg.contract, ...(stackFlags.baseUrl ? { baseUrl: stackFlags.baseUrl, auth: stackFlags.auth, environment: stackFlags.environment } : {}),
        files: [join(folder, 'stack.json'), join(folder, basename(cfg.contract)), join(folder, basename(LEGACY_CONTEXT_FILE))] };
    })() : null;
  if (firstStackPlan && stackFlags.baseUrl) {
    // Validate the explicit target before any write, exactly as stack add would.
    planStack(root, firstStackPlan.name, { baseUrl: stackFlags.baseUrl, auth: stackFlags.auth, environment: stackFlags.environment });
  }

  // No contract: create the first stack from --base-url, or from the one API
  // the code visibly calls. Without a stack, requests stay in private
  // evidence and notes have nowhere to land. Planned here, written only at the
  // write boundary below, so a blocked setup still writes nothing anywhere.
  const cliForCommands = commandResolution.portable.available ? commandResolution.portable.command : localCli;
  let bareStack = null;
  let firstStack_ = firstStackReport;
  if (stackEligible && !firstStackPlan && !(contextProblem && contextProblem.code !== "CONTRACT_NOT_FOUND")) {
    let choice = null, candidates = [];
    if (stackFlags.baseUrl) {
      let host;
      try { host = new URL(stackFlags.baseUrl).hostname; } catch { host = ""; }
      choice = { stack: stackFlags.name ?? stackNameFromHost(host), base_url: stackFlags.baseUrl, source: "flag" };
    } else {
      const detected = detectFirstStack(root, upstreamUrls(root, null), { cli: cliForCommands });
      candidates = detected.candidates;
      if (detected.selected) choice = { stack: stackFlags.name ?? detected.selected.stack, base_url: detected.selected.base_url,
        source: "detected-in-code", file: detected.selected.file };
    }
    if (choice) {
      const plan = planStack(root, choice.stack, { baseUrl: choice.base_url,
        ...(stackFlags.auth ? { auth: stackFlags.auth } : {}), ...(stackFlags.environment ? { environment: stackFlags.environment } : {}) });
      const folder = join(root, plan.relativeFolder);
      bareStack = { plan, choice, files: [join(root, plan.stackFile), join(folder, CONTEXT_BASENAME)] };
      // planStack has refused credentials, a query and a fragment, so the
      // reported base URL is exactly what the stack file stores.
      firstStack_ = { action: dryRun ? "would create" : "create", ...choice,
        environment: plan.environment, ...(candidates.length ? { candidates } : {}) };
    } else firstStack_ = { action: "none", candidates,
      message: "Nothing your agent calls is kept until a stack exists.",
      next: candidates.length ? `Choose the API this repository calls and run its candidate command, or run ${cliForCommands} connect --base-url <url>.`
        : `Run ${cliForCommands} connect --base-url <url> or ${cliForCommands} stack add <name> --base-url <url>; an OpenAPI contract is optional.` };
  } else if (stackEligible && firstStackPlan) {
    firstStack_ = { action: dryRun ? "would create" : "create", stack: firstStackPlan.name, source: "contract",
      contract: rel(root, firstStackPlan.contract) };
  }

  // 3. Skills. The write convention is the accumulation mechanism: a tester who
  //    does not get it installed accumulates nothing and concludes, correctly
  //    from where they sit, that the product does nothing.
  const skillPlans = [];
  if (!argv.includes("--no-skills")) {
    // Checked BEFORE planning, so an incomplete install is a named error with a
    // fix instead of an ENOENT stack trace out of the middle of a plan — and so
    // a half-wired repo is never left behind by a crash between two writes.
    const gone = missingSkills();
    if (gone.length)
      die("SKILL_NOT_FOUND",
        `This installation is missing ${gone.length} of its skills:\n  ${gone.join("\n  ")}`,
        `The skills are how anything accumulates, so connect will not proceed without them. ` +
        `Reinstall the package, or re-run with --no-skills to wire the MCP server alone.`);
    for (const s of planSkills(root, { alpha: argv.includes("--alpha"), force: argv.includes("--force-skills"),
      cliName: commandResolution.portable.available ? commandResolution.portable.command : null })) {
      if (s.action === "conflict") conflicts += 1;
      skillPlans.push(s);
    }
  }
  const skills = skillPlans.map((s) => ({ name: s.name, host: s.host, label: s.label,
        path: rel(root, s.to), action: s.action,
        ...(s.documentationOmitted ? { documentation_omitted: true, documentation_remedy: s.documentationRemedy } : {}),
        ...(s.reason ? { reason: localize(s.reason) } : {}),
        ...(s.fix ? { fix: localize(s.fix) } : {}) }));

  // 4. Plan pointer bytes after resolution and context planning, still without
  // touching either file.
  const pointerRegistrations = [...discoverMcpRegistrations(root),
    ...mcpPlans.filter(({ plan }) => plan && plan.action !== "conflict")
      .map(({ target }) => ({ ...entry, key: MCP_SERVER_KEY, host: target.id }))];
  const pointerPlans = !argv.includes("--no-pointers")
    ? planPointers(root, ctx, commandResolution, pointerRegistrations) : [];
  conflicts += pointerPlans.filter(({ action }) => action === "conflict").length;
  const pointers = pointerPlans.map(({ file, action, reason, target = "managed_block" }) => ({ file, target,
    action: dryRun && !["conflict", "unchanged"].includes(action) ? "would write" : action,
    ...(reason ? { reason } : {}) }));
  const omitted = [
    ...pointerOmissions(commandResolution, pointerPlans.map(({ file }) => file)),
    ...skillPlans.filter(({ commandOmitted }) => commandOmitted)
      .map(({ to }) => commandOmission(rel(root, to), commandResolution)),
  ];

  // 5. Credentials, by NAME only. An MCP host does not run a login shell, so a
  //    key that works in the tester's terminal is simply absent for the server
  //    the host spawns — with per-host auth, often for only ONE vendor, which
  //    is the most confusing version of that failure.
  const credentials = credentialReport(cfg.file ?? null);

  // 6. The machine registry. Connect is the adoption act, so it is also where
  //    the repo becomes VISIBLE to the cross-repo grant system — and only
  //    visible: default-deny means registration grants nothing in either
  //    direction. A damaged registry must not fail the wiring; it is reported
  //    on its own line and stepped past.
  let registryStep;
  let registryPlan = null;
  const { registry, problem: registryProblem } = loadRegistry();
  if (registryProblem) registryStep = { action: "skipped", file: registryPath(), reason: registryProblem.message };
  else {
    const { created } = registerRepo(registry, root);
    registryPlan = registry;
    registryStep = { action: dryRun
      ? (created ? "would register" : "would refresh")
      : (created ? "registered" : "refreshed"), file: registryPath() };
  }

  // Writability is part of the plan, not a surprise delegated to the write
  // loop. Check every target that this invocation would mutate—including the
  // second pointer and machine-local registry—before the first byte lands.
  let layoutPlan;
  try { layoutPlan = planLayout(root); }
  catch (error) { die(error.code ?? "LAYOUT_UNSAFE_PATH", error.message, error.next ?? "Repair the named project layout path before setup; nothing was written."); }
  const pendingWrites = [
    ...layoutPlan.files.filter(row => !existsSync(join(root, row.path)) || readFileSync(join(root, row.path), "utf8") !== row.content).map(row => ({ surface: row.path, path: join(root, row.path), kind: "layout" })),
    ...(contractPlan.file ? [{ surface: "primary contract binding", path: contractPlan.file,
      row: contractPlan.report }] : []),
    ...(hookIgnorePlan?.action === "append"
      ? [{ surface: "Claude hook local ignore", path: hookIgnorePlan.path, row: hooks.claude_code.ignore }] : []),
    ...(hookPlan && hookPlan.action !== "unchanged"
      ? [{ surface: CLAUDE_HOOK_SETTINGS, path: hookTarget, row: hooks.claude_code }] : []),
    ...(ci ? [ci.workflow, ci.tarball].filter(({ action }) => ["would write", "would remove"].includes(action))
      .map((row) => ({ surface: row.path, path: join(root, row.path), row })) : []),
    ...mcpPlans.filter(({ plan }) => plan && !["unchanged", "conflict"].includes(plan.action))
      .map(({ target, public: row }) => ({ surface: row.file, path: target.file, row })),
    ...(firstStackPlan ? firstStackPlan.files.map(path => ({ surface: rel(root, path), path, kind: 'context' }))
      : bareStack ? bareStack.files.map(path => ({ surface: rel(root, path), path, kind: 'context' }))
      : inventoryPlan ? [{ surface: contextFile(), path: join(root, contextFile()), kind: "context" }] : []),
    ...skillPlans.filter(({ action }) => !["unchanged", "differs", "conflict"].includes(action))
      .map((plan, _index) => ({ surface: rel(root, plan.to), path: plan.to,
        row: skills.find(({ path }) => path === rel(root, plan.to)) })),
    ...skillPlans.filter(plan => plan.migratedFrom && !['unchanged', 'differs', 'conflict'].includes(plan.action))
      .map(plan => ({ surface: rel(root, plan.migratedFrom), path: plan.migratedFrom,
        removal: true, row: skills.find(({ path }) => path === rel(root, plan.to)) })),
    ...pointerPlans.filter(({ action }) => !["unchanged", "conflict"].includes(action))
      .map((plan) => ({ surface: plan.file, path: plan.path,
        row: pointers.find(({ file }) => file === plan.file) })),
    ...(registryPlan ? [{ surface: "registry", path: registryPath(), kind: "registry" }] : []),
  ];
  for (const target of pendingWrites) {
    const problem = writableDestinationProblem(target.path);
    if (!problem) continue;
    conflicts += 1;
    if (target.row) Object.assign(target.row, { action: "conflict", reason: problem });
    else if (target.kind === "context") context = `not written — ${problem}`;
    else if (target.kind === "registry") registryStep = { ...registryStep,
      action: "conflict", reason: problem };
  }

  // Report persistent writes, including generated layout and ignore files.
  // Atomic scratch/lock files are implementation details, not retained output.
  const plannedFiles = [...new Map([
    ...createdStackFiles.map(path => [join(root, path), { path, action: 'created' }]),
    ...pendingWrites.map(target => [target.path, {
      path: target.path.startsWith(root + "/") ? rel(root, target.path) : target.path,
      action: target.removal || target.row?.action === "would remove" ? "removed"
        : existsSync(target.path) ? "updated" : "created",
    }]),
  ]).values()];

  // The planning boundary. An unresolved portable command is a named partial,
  // not a conflict, so the MCP/fallback surfaces below still land. A real
  // conflict writes nothing anywhere: not even an otherwise-ready sibling MCP
  // target, registry row, hook, or first pointer.
  if (!dryRun && conflicts === 0) {
    if (firstStackPlan) {
      const created = firstStack(root, firstStackPlan);
      return withStackScope(created.scope, () => cmdConnect(argv, { silent,
        selectedContract: created.scope.config.contract, createdStackFiles: created.created,
        firstStackReport: { ...firstStack_, action: "created", base_url: created.scope.config.baseUrl ?? null } }));
    }
    if (bareStack) {
      const created = createStack(root, bareStack.plan.name, { baseUrl: bareStack.choice.base_url,
        ...(stackFlags.auth ? { auth: stackFlags.auth } : {}), ...(stackFlags.environment ? { environment: stackFlags.environment } : {}) });
      withStackScope(created.scope, () => saveContext(root, emptyContext({ name: created.document.title ?? created.stack, contractPath: null, contractDigest: null })));
      return withStackScope(created.scope, () => cmdConnect(argv, { silent, createdStackFiles: [...created.created, created.contextFile],
        firstStackReport: { ...firstStack_, action: "created" } }));
    }
    ensureLayout(root);
    if (argv.includes("--ci")) {
      try { ci = materializeCiArtifacts(root, { ...ciOptions, dryRun: false }); }
      catch (error) {
        die(error?.code ?? "CI_ARTIFACT_WRITE_FAILED", error?.message ?? "Could not materialize CI artifacts.",
          "Review the existing CI artifacts before retrying connect --ci.");
      }
    }
    applyClaudeHookIgnore(hookIgnorePlan);
    if (hookPlan && hookPlan.action !== "unchanged") writeText(hookTarget, hookPlan.text, root);
    if (contractPlan.file) writeText(contractPlan.file, contractPlan.text, root);
    for (const { target, plan } of mcpPlans)
      if (plan && plan.action !== "unchanged" && plan.action !== "conflict")
        writeText(target.file, plan.text, root);
    if (inventoryPlan) saveContext(root, inventoryPlan.ctx);
    for (const s of skillPlans)
      if (s.action !== "unchanged" && s.action !== "differs" && s.action !== "conflict") {
        writeText(s.to, s.body, root);
        if (s.migratedFrom && readFileSync(s.to, 'utf8') === s.body)
          removeSkill(s.migratedFrom, root);
      }
    applyPointerPlans(pointerPlans);
    if (registryPlan) saveRegistry(registryPlan);
  }
  if (!dryRun && conflicts > 0) {
    for (const row of mcp)
      if (!["conflict", "manual", "unchanged"].includes(row.action)) row.action = `would ${row.action}`;
    for (const row of skills)
      if (!["conflict", "differs", "unchanged"].includes(row.action)) row.action = `would ${row.action}`;
    for (const row of pointers)
      if (!["conflict", "unchanged"].includes(row.action)) row.action = `would ${row.action}`;
    if (hookPlan && hookPlan.action !== "unchanged" && hooks.claude_code.action !== "conflict")
      hooks.claude_code.action = `would_${hookPlan.action}`;
    if (hookIgnorePlan?.action === "append" && hooks.claude_code.ignore.action !== "conflict")
      hooks.claude_code.ignore.action = "would_append";
    if (inventoryPlan && context === "wrote") context = "not written — plan has conflicts";
    if (firstStack_?.action === "create") firstStack_ = { ...firstStack_, action: "not created", reason: "the connect plan has conflicts" };
    if (registryPlan && registryStep.action !== "conflict") registryStep = { ...registryStep, action: "not written",
      reason: "the connect plan has conflicts" };
  }

  const report = {
    ...(unselectedStacks ? { stack_selection: { state: 'not_selected', code: 'STACK_REQUIRED', available: stackCatalog(root).stacks.map(row => row.name) } } : {}),
    registry: registryStep,
    ...(firstStack_ ? { first_stack: firstStack_ } : {}),
    ...(dryRun ? { dry_run: true } : {}),
    server: SERVER_PATH, config: cfg.file ?? null,
    contract_binding: { ...contractPlan.report,
      ...(contractPlan.report.action === "bind" ? { action: dryRun || conflicts > 0 ? "would bind" : "bound" } : {}) },
    mcp, skills, pointers, omitted,
    launch: { command: entry.command, args: entry.args },
    touched_files: !dryRun && conflicts === 0 ? plannedFiles : [],
    planned_files: plannedFiles,
    command_resolution: publicCommandResolution(commandResolution),
    context, credentials, hooks,
    ...(ci ? { ci } : {}),
    // Said once, plainly, because the file is committed and the next person to
    // read it is a teammate on a different machine: the paths are absolute for
    // THIS install (an MCP host spawns with an arbitrary cwd, so they must be),
    // which means a clone needs its own `connect`, not a debugging session.
    note: `Paths in the generated config are absolute for this machine. ` +
          (commandResolution.portable.available
            ? `A teammate who clones the repo installs the team's selected CLI version, then runs \`${commandResolution.portable.command} connect\` in their checkout.`
            : `A teammate who clones the repo installs the team's selected CLI version and runs its connect command in their checkout.`),
    verify: `${localCli} start --dry-run --json`,
  };

  const setupEvidence = stackEvidenceClasses(root, ctx ?? {}, { config: cfg,
    contract: contractPlan.contract ? loadHttpContract(contractPlan.contract, { pathPrefix: cfg.contractPathPrefix }) : null });
  report.setup = setupReceipt({ report, context: ctx, contextProblem,
    evidenceClasses: setupEvidence.counts, operationCount: setupEvidence.operations.size, verified: setupEvidence.counts.verified,
    cfg, conflicts, dryRun, bindingId: entry.env.API_SETUP_BINDING,
    serverKey: conflicts || dryRun ? mcpPlans.find(row => row.plan?.registeredKey)?.plan.registeredKey ?? null : MCP_SERVER_KEY,
    cli: commandResolution.portable.available ? commandResolution.portable.command : localCli });
  report.next = conflicts ? "Resolve the reported conflicts, then run setup again."
    : dryRun ? `Apply this setup with ${localCli} start.` : report.setup.continuation.instruction;
  process.exitCode = conflicts ? 1 : 0;
  if (silent) return report;

  if (asJson) console.log(JSON.stringify(report, null, 1));
  else {
    const out = [`${localCli} connect — ${root}${dryRun ? "  (dry run: nothing written)" : ""}\n`];
    for (const m of mcp) {
      out.push(`  ${m.action.padEnd(9)} ${m.label.padEnd(18)} ${m.file}`);
      if (m.reason) out.push(`       ${m.reason}`);
      if (m.fix) out.push(`       ${m.fix}`);
      if (m.snippet) out.push(m.snippet.split("\n").map((l) => `         ${l}`).join("\n"));
    }
    for (const s of skills) {
      out.push(`  ${s.action.padEnd(9)} skill              ${s.path}`);
      if (s.reason) out.push(`       ${s.reason}`);
      if (s.fix) out.push(`       ${s.fix}`);
    }
    for (const p of pointers) out.push(`  ${String(p.action).padEnd(9)} pointer            ${p.file}`);
    for (const omission of omitted) {
      out.push(`  omitted   command            ${omission.surface}`);
      out.push(`       command: ${omission.command}`);
      out.push(`       reason: ${omission.reason}`);
      out.push(`       remedy: ${omission.remedy}`);
    }
    if (wantsClaudeHook) {
      out.push(`  ${hooks.claude_code.action.padEnd(13)} Claude Code hook   ${hooks.claude_code.path}`);
      if (hooks.claude_code.ignore) {
        const ignore = hooks.claude_code.ignore;
        out.push(`       local ignore: ${ignore.action}${ignore.code ? ` (${ignore.code})` : ""}${ignore.reason ? ` — ${ignore.reason}` : ""}`);
      }
      if (hooks.claude_code.fix) out.push(`       ${hooks.claude_code.fix}`);
      out.push(`       scope: ${hooks.claude_code.scope}`);
      out.push(`  ${hooks.codex.action.padEnd(13)} Codex hook`);
      out.push(`       ${hooks.codex.reason}`);
      out.push(`       ${hooks.codex.fallback}`);
    }
    if (ci) {
      out.push(`  CI install: ${ci.install}${ci.transition ? ` (${ci.transition})` : ""}`);
      out.push(`  ${ci.workflow.action.padEnd(9)} workflow           ${ci.workflow.path}`);
      out.push(`  ${ci.tarball.action.padEnd(9)} vendored engine    ${ci.tarball.path}`);
      if (ci.tarball.reason) out.push(`       ${ci.tarball.reason}`);
    }
    out.push(`  ${registryStep.action.padEnd(9)} ${"registry".padEnd(18)} ${registryStep.file}`);
    if (registryStep.reason) out.push(`       ${registryStep.reason}`);
    // "skipped" carries its reason after an em dash; render the reason on its
    // own line so the filename stays in the column every other row uses.
    const [ctxState, ...ctxWhy] = context.split(" — ");
    out.push(`  ${ctxState.padEnd(9)} ${contextFile()}`);
    if (ctxWhy.length) out.push(`       ${ctxWhy.join(" — ")}`);
    const unresolved = credentials.filter((c) => c.state !== "envFile");
    if (unresolved.length) {
      out.push("", "  credentials an MCP host will NOT inherit from your shell:");
      for (const c of unresolved) out.push(`    ${(c.var ?? c.scope).padEnd(24)} ${c.state}\n       ${c.fix}`);
    }
    if (firstStack_) {
      out.push("");
      if (["created", "would create", "not created"].includes(firstStack_.action)) {
        const how = firstStack_.source === "flag" ? "from --base-url" : firstStack_.source === "contract" ? `from ${firstStack_.contract}`
          : `detected in code (${terminalText(firstStack_.file)})`;
        out.push(`  First API stack ${firstStack_.action === "created" ? "created" : firstStack_.action}: ${firstStack_.stack}${firstStack_.base_url ? ` → ${terminalText(firstStack_.base_url)}` : ""}, ${how}.`);
        if (firstStack_.reason) out.push(`       ${firstStack_.reason}`);
      } else {
        out.push(`  ${firstStack_.message}`);
        if (firstStack_.candidates.length) {
          out.push("  APIs found in the code (none created):");
          for (const row of firstStack_.candidates)
            out.push(`    ${terminalText(row.command)}${row.reason ? `   # ${row.reason}` : ""}`);
        }
        out.push(`  ${firstStack_.next}`);
      }
    }
    out.push("", dryRun || conflicts ? "  Planned files (nothing written):" : "  Files touched:");
    for (const row of dryRun || conflicts ? report.planned_files : report.touched_files)
      out.push(`  ${row.action.padEnd(9)} ${terminalText(row.path)}`);
    out.push("", `  ${report.note}`, "", renderSetupReceipt(report.setup));
    if (conflicts) out.push(report.next);
    console.log(out.join("\n"));
  }
  // exitCode, not exit(): the process ends when the event loop drains, so a
  // long conflict snippet on a pipe is never truncated by an early teardown.
  process.exitCode = conflicts ? 1 : 0;
  return report;
}

// The undo. It removes exactly what connect recognises as ITS OWN — a foreign
// server parked under our key, or a skill the user has edited, is left alone
// and reported, because an undo that deletes someone else's work to be thorough
// is the same clobber as the one connect refuses to make on the way in.
async function cmdUnwire(argv) {
  const { mcpTargets, planRemoval, planSkillRemoval, planLibrarianAgentRemoval,
    librarianMcpRegistration, removeSkill, writeText, pruneEmptyDirs, projectEntry, installedProjectEntry,
    projectPathProblem } =
    await import("../lib/connect.mjs");
  const { CLAUDE_HOOK_SETTINGS, claudeHookFileProblem,
    claudeHookTarget, planClaudeHookRemoval } = await import("../lib/claude-hook.mjs");
  const { planClaudeHookIgnoreRemoval, applyClaudeHookIgnore, claudeHookIgnoreReport } =
    await import("../lib/claude-hook-ignore.mjs");
  const { applyCiArtifactRemoval, planCiArtifactRemoval, pruneCiArtifactDirs } =
    await import("../lib/ci-workflow.mjs");
  const root = repoRoot();
  const cfg = resolveConfig(root);
  const currentEntry = projectEntry(root, cfg);
  const installedEntry = installedProjectEntry(root) ?? currentEntry;

  const hookTarget = claudeHookTarget(root);
  let claudeHook = { path: CLAUDE_HOOK_SETTINGS, action: "absent" };
  const hookUnsafe = projectPathProblem(root, hookTarget) ?? claudeHookFileProblem(hookTarget);
  if (hookUnsafe) claudeHook = { path: CLAUDE_HOOK_SETTINGS, action: "left",
    reason: `${hookUnsafe}; symbolic links are not followed during unwire` };
  else if (existsSync(hookTarget)) {
    const plan = planClaudeHookRemoval(readFileSync(hookTarget, "utf8"));
    claudeHook = { path: CLAUDE_HOOK_SETTINGS,
      action: plan.action,
      ...(plan.reason ? { reason: plan.reason } : {}) };
    if (plan.action === "removed") {
      if (plan.text == null) removeSkill(hookTarget, root);
      else writeText(hookTarget, plan.text, root);
    }
  }

  const hookIgnorePlan = planClaudeHookIgnoreRemoval(root);
  applyClaudeHookIgnore(hookIgnorePlan);
  claudeHook.ignore = claudeHookIgnoreReport(hookIgnorePlan);

  const ciPlan = planCiArtifactRemoval(root, { pathProblem: projectPathProblem });
  applyCiArtifactRemoval(ciPlan);
  const ci = {
    workflow: { path: ciPlan.workflow.path, action: ciPlan.workflow.action,
      ...(ciPlan.workflow.reason ? { reason: ciPlan.workflow.reason } : {}) },
    tarball: { path: ciPlan.tarball.path, action: ciPlan.tarball.action,
      ...(ciPlan.tarball.reason ? { reason: ciPlan.tarball.reason } : {}) },
    pruned: pruneCiArtifactDirs(root, ciPlan, { pathProblem: projectPathProblem }),
  };

  const pointers = unwirePointers(root);
  const mcp = [];
  for (const t of mcpTargets(root)) {
    const unsafe = projectPathProblem(root, t.file);
    if (unsafe) {
      mcp.push({ file: rel(root, t.file), action: "left",
        reason: `${unsafe}; symbolic links are not followed during unwire` });
      continue;
    }
    if (!t.writable || !existsSync(t.file)) continue;
    const plan = planRemoval(readFileSync(t.file, "utf8"), t);
    if (!plan) continue;
    if (plan.action === "removed") writeText(t.file, plan.text, root);
    mcp.push({ file: rel(root, t.file), action: plan.action, ...(plan.reason ? { reason: plan.reason } : {}) });
  }
  const restricted = librarianMcpRegistration(root, installedEntry);
  let librarianMcp = { file: rel(root, restricted.target.file), action: "absent" };
  const restrictedUnsafe = projectPathProblem(root, restricted.target.file);
  if (restrictedUnsafe) librarianMcp = { file: rel(root, restricted.target.file), action: "left",
    reason: `${restrictedUnsafe}; symbolic links are not followed during unwire` };
  else if (existsSync(restricted.target.file)) {
    const text = readFileSync(restricted.target.file, "utf8");
    let plan = planRemoval(text,
      restricted.target, restricted.key, restricted.entry);
    // Preserve the existing exact-current legacy cleanup as well: a historical
    // librarian can have been installed separately from the ordinary server.
    if (plan?.action === "left") {
      const fallback = planRemoval(text, restricted.target, restricted.key,
        librarianMcpRegistration(root, currentEntry).entry);
      if (fallback?.action === "removed") plan = fallback;
    }
    if (plan) {
      if (plan.action === "removed") writeText(restricted.target.file, plan.text, root);
      librarianMcp = { file: rel(root, restricted.target.file), action: plan.action,
        ...(plan.reason ? { reason: plan.reason } : {}) };
    }
  }
  const skills = [];
  if (!argv.includes("--keep-skills"))
    for (const s of planSkillRemoval(root)) {
      if (s.action === "absent") continue;
      if (s.action === "removed") removeSkill(s.to, root);
      skills.push({ name: s.name, host: s.host, label: s.label,
        path: rel(root, s.to), action: s.action, ...(s.reason ? { reason: s.reason } : {}) });
    }
  const agents = [];
  for (const agent of planLibrarianAgentRemoval(root, installedEntry, [currentEntry])) {
    if (agent.action === "absent") continue;
    if (agent.action === "removed") removeSkill(agent.to, root);
    agents.push({ name: agent.name, host: agent.host, label: agent.label,
      path: rel(root, agent.to), action: agent.action,
      ...(agent.reason ? { reason: agent.reason } : {}) });
  }

  // …and the tree those skills lived in, if connect is what created it and
  // nothing else moved in. An undo that leaves an empty host directory behind makes
  // the next person work out who put it there.
  const pruned = pruneEmptyDirs(root).map((d) => rel(root, d));

  const removed = [...pointers.filter((p) => p.action === "removed").map((p) => p.file),
    ...mcp.filter((m) => m.action === "removed").map((m) => m.file),
    ...(librarianMcp.action === "removed" ? [librarianMcp.file] : []),
    ...skills.filter((s) => s.action === "removed").map((s) => s.path),
    ...agents.filter((a) => a.action === "removed").map((a) => a.path),
    ...[ci.workflow, ci.tarball].filter((a) => a.action === "removed").map((a) => a.path),
    ...(claudeHook.action === "removed" ? [claudeHook.path] : []),
    ...(claudeHook.ignore.action === "removed" ? [claudeHook.ignore.path] : []),
    ...ci.pruned, ...pruned];
  const left = [...pointers, ...mcp, librarianMcp, ...skills, ...agents,
    claudeHook, claudeHook.ignore, ci.workflow, ci.tarball].filter(row => row.action === "left");
  const report = { removed: removed.length ? removed : "nothing to remove", pointers, mcp,
    librarian_mcp: librarianMcp, skills, agents, hooks: { claude_code: claudeHook }, ci, pruned,
    complete: left.length === 0, left,
    note: `API knowledge, configuration and evidence in ${LAYOUT.directory}/ are retained. ` +
      "Empty host configuration and instruction files may remain; their managed registrations and pointer blocks were removed where reported.",
    next: left.length ? "Review the reported leftovers before treating this repository as disconnected. Then reload or restart the coding host."
      : "Reload or restart the coding host to unload its previously loaded tools and instructions." };
  if (argv.includes("--json")) { console.log(JSON.stringify(report, null, 1)); return; }
  // Say WHAT was removed from each file, not just the filename: ".mcp.json"
  // under a "removed:" heading reads as though the file itself is gone, which
  // is the one thing this command must never be mistaken for doing.
  const lines = [
    ...pointers.filter((p) => p.action === "removed")
      .map((p) => `  pointer block   removed from ${p.file}`),
    ...pointers.filter((p) => p.action === "left")
      .map((p) => `  pointer block   LEFT in ${p.file} — ${p.reason}`),
    ...mcp.filter((m) => m.action === "removed").map((m) => `  registration    removed from ${m.file} (other servers untouched)`),
    ...mcp.filter((m) => m.action === "left").map((m) => `  registration    LEFT in ${m.file} — ${m.reason}`),
    ...(librarianMcp.action === "removed" ? [`  librarian MCP  removed from ${librarianMcp.file} (other servers untouched)`] : []),
    ...(librarianMcp.action === "left" ? [`  librarian MCP  LEFT in ${librarianMcp.file} — ${librarianMcp.reason}`] : []),
    ...skills.filter((s) => s.action === "removed").map((s) => `  skill           removed ${s.path}`),
    ...skills.filter((s) => s.action === "left").map((s) => `  skill           LEFT ${s.path} — ${s.reason}`),
    ...agents.filter((a) => a.action === "removed").map((a) => `  librarian agent removed ${a.path}`),
    ...agents.filter((a) => a.action === "left").map((a) => `  librarian agent LEFT ${a.path} — ${a.reason}`),
    ...(claudeHook.action === "removed" ? [`  Claude hook     removed from ${claudeHook.path}`] : []),
    ...(claudeHook.action === "left" ? [`  Claude hook     LEFT in ${claudeHook.path} — ${claudeHook.reason}`] : []),
    ...(claudeHook.ignore.action === "removed" ? [`  Claude ignore   removed from ${claudeHook.ignore.path}`] : []),
    ...(claudeHook.ignore.action === "left" ? [`  Claude ignore   LEFT in ${claudeHook.ignore.path} — ${claudeHook.ignore.reason}`] : []),
    ...(ci.workflow.action === "removed" ? [`  workflow        removed ${ci.workflow.path}`] : []),
    ...(ci.workflow.action === "left" ? [`  workflow        LEFT ${ci.workflow.path} — ${ci.workflow.reason}`] : []),
    ...(ci.tarball.action === "removed" ? [`  vendored engine removed ${ci.tarball.path}`] : []),
    ...(ci.tarball.action === "left" ? [`  vendored engine LEFT ${ci.tarball.path} — ${ci.tarball.reason}`] : []),
    ...ci.pruned.map((d) => `  directory       removed ${d} (empty after CI cleanup)`),
    ...pruned.map((d) => `  directory       removed ${d} (empty)`),
  ];
  console.log((lines.length ? `${CLI_NAME} unwire\n${lines.join("\n")}`
                           : `${CLI_NAME} unwire — nothing of ours in ${root}.`) +
    `\n\n${report.note}\n${report.next}`);
}

// --- learn -----------------------------------------------------------------

async function cmdLearn(argv) {
  const root = repoRoot();
  requireStackMigrationBeforeWriting(root);
  const selected = requestArgs(argv, "learn", {
    booleans: ["--dry-run", "--json", "--agents", "--ci"],
    equals: ["--limit"],
  });
  argv = selected.args;
  const cfg = selectRequestConfig(root, selected.environment);
  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");
  // Fix the pointer command tier and omission set before requests or context
  // writes. The observations can change pointer facts, never which command is
  // safe to commit.
  const commandResolution = advertisementPlan(root);
  const pointerStateAtStart = inspectPointerFiles(root);
  const pointerBlocksAtStart = pointerStateAtStart.filter(({ managed }) => managed)
    .map(({ file }) => file);
  const willTouchPointers = argv.includes("--agents") || pointerBlocksAtStart.length > 0;
  const pointerProblem = willTouchPointers
    ? pointerStateAtStart.find(({ problem }) => problem) : null;
  if (pointerProblem) die("POINTER_CONFLICT",
    `${pointerProblem.file}: ${pointerProblem.problem}; nothing was executed or written.`,
    `Repair that pointer file, then re-run ${commandResolution.local.command} learn --agents.`);
  const snapshot = loadContextSnapshot(root);
  const ctx = snapshot?.ctx;
  if (!ctx) die("NO_CONTEXT", `No ${contextFile()} in ${root}.`, initHint(root));
  if (!dryRun) {
    const plannedTargets = [
      { surface: contextFile(), path: join(root, contextFile()) },
      ...(willTouchPointers ? pointerStateAtStart.map(({ file, path }) => ({ surface: file, path })) : []),
    ];
    const unwritable = plannedTargets.map((row) => ({ ...row,
      problem: writableDestinationProblem(row.path) })).find(({ problem }) => problem);
    if (unwritable) die("WRITE_PLAN_CONFLICT",
      `${unwritable.surface}: ${unwritable.problem}; nothing was executed or written.`,
      `Make that project target writable, then re-run ${commandResolution.local.command} learn --agents.`);
  }

  const base = cfg.baseUrl;
  const limit = Number(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 200);
  // --dry-run: execute the safe reads, show what WOULD land in the committed
  // file and what would be refused and why. Knowledge/pointers stay unchanged;
  // the shared client still retains private execution evidence. The gate a human
  // or CI runs before letting promotion touch the repo. It shares the read loop
  // and the promotion path with a real learn, so the preview cannot disagree
  // with the write it predicts — the only difference is that it never saves.
  // --ci: the deposit path with NO agent in the loop (PRD C2). Same reads,
  // same promotion boundary, same write as a plain learn — the differences are
  // all posture: it refuses production outright (a committable artifact must
  // never be built from production observations, and a pipeline pointed there
  // is misconfigured, not unlucky), it refuses --dry-run (a deposit that
  // writes no knowledge is a contradiction; audit --ci/--baseline set the precedent
  // for naming that), and unreachability NEVER reaches the file — a plain
  // learn records "unreachable" as knowledge for the human who ran it, but in
  // CI a network blip must not erase verification previous runs accumulated
  // in a committed artifact.
  const asCi = argv.includes("--ci");
  if (asCi && dryRun)
    die("CI_AND_DRY_RUN", "--dry-run writes no knowledge; --ci exists to write the deposit. One run cannot do both.",
      "Preview with learn --dry-run; deposit with learn --ci.");
  if (asCi && cfg.production)
    die("CI_DEPOSIT_PRODUCTION", `Environment '${cfg.name}' is marked production; a CI deposit writes nothing there.`,
      "Point API_ENV (or the config default) at a non-production environment. The promotion boundary refuses production values anyway; refusing the whole run keeps the artifact clean.");

  // MCP-only contexts have no HTTP contract; their declarations still need
  // the same --agents delivery path, with zero HTTP reads to execute.
  const contractPath = ctx.api.contract ? resolve(root, ctx.api.contract) : null;
  const { doc, digest } = contractPath ? readContract(contractPath) : { doc: {}, digest: null };

  // Stamp every promoted observation with who ran the learn — a marker, never
  // PII (see authorMarker). Computed once per run, not per operation.
  const learnStamp = provenanceStamp(root);
  const author = learnStamp.by;

  const allOperations = Object.entries(ctx.operations);
  const isSafeRead = (op, entry) => entry.effect === "read" && ["GET", "HEAD"].includes(op.split(" ")[0]);
  const safeReads = allOperations.filter(([op, entry]) => isSafeRead(op, entry) && !op.includes("{"));
  const reads = safeReads.slice(0, limit);
  for (const [operation, entry] of reads) {
    const history = inspectNoteHistory(entry, operation);
    if (["invalid", "changed", "unbaselined"].includes(history.state)) {
      noteWriteError(Object.assign(new Error("Review this note history before learn changes it; no request was executed."), {
        code: history.state === "invalid" ? "NOTE_HISTORY_INVALID" : history.state === "changed" ? "NOTE_HISTORY_CHANGED" : "NOTE_BASELINE_REQUIRED",
        operation, digest: history.digest,
      }));
    }
  }
  const executedOps = new Set(reads.map(([op]) => op));
  const skipped = allOperations
    .filter(([op]) => !executedOps.has(op))
    .map(([op, entry]) => {
      if (!isSafeRead(op, entry)) return {
        op,
        reason: "write — needs --agents",
        unblock: "Use an explicitly authorized agent probe or suite; learn executes GET/HEAD only.",
      };
      if (op.includes("{")) return {
        op,
        reason: "no id available",
        unblock: "Provide a concrete identifier and run that operation explicitly.",
      };
      return {
        op,
        reason: "limit reached",
        unblock: `Increase --limit above ${limit}.`,
      };
    });

  let learned = 0, failed = 0, drifted = 0, requestAttempts = 0;
  const preview = [], outcomes = [];
  const { apiLearnRead, transportError } = reads.length ? await import("../lib/client.mjs") : {};
  for (const [op, entry] of reads) {
    const [method, path] = op.split(" ");
    let observation;
    try {
      observation = await apiLearnRead({ method, path, onAttempt: () => { requestAttempts += 1; } });
    } catch (error) {
      const detail = transportError(error).code;
      const transportFailed = ["TRANSPORT_FAILED", "REQUEST_TIMEOUT", "ECONNREFUSED", "ECONNRESET",
        "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(detail);
      if (transportFailed) failed += 1;
      const receipt = { op, outcome: transportFailed ? "unreachable" : "client_failed", code: detail, verified: false };
      outcomes.push(receipt);
      if (dryRun) {
        preview.push(transportFailed ? { op, unreachable: detail } : { ...receipt, status: null,
          would_promote: { status_codes: [], fields: {} }, would_refuse: [] });
        continue;
      }
      // A CI transport/client failure must not erase the last committed observation.
      if (asCi) continue;
      ctx.operations[op] = transportFailed
        ? recordReachabilityFailure(entry, { base, detail, stamp: learnStamp })
        : recordLearnFailure(entry, { ...receipt, stamp: learnStamp });
      continue;
    }

    const { result, status, drift, body, verified } = observation;
    const redirected = drift.some(item => item.kind === "redirect");
    if (redirected) drifted += 1;
    const outcome = verified ? "verified" : status === 401 || status === 403 ? "authentication_failed"
      : redirected ? "redirected" : status == null ? "request_refused" : "http_failed";
    const receipt = { op, outcome, status, verified, evidence: result.evidence ?? null,
      assertions: result.assertions ? { passed: result.assertions.passed, failed: result.assertions.failed } : null,
      ...(result.error?.code ? { code: result.error.code } : {}) };
    outcomes.push(receipt);
    const contract = responseSchema(doc, method, path);
    const environment = { name: cfg.name, production: cfg.production };

    if (!verified) {
      if (dryRun) preview.push({ ...receipt, would_promote: { status_codes: [], fields: {} }, would_refuse: [],
        ...(drift.length ? { drift } : {}) });
      else ctx.operations[op] = recordLearnFailure(entry, { ...receipt, stamp: learnStamp, drift });
      continue;
    }
    if (dryRun) {
      const { promoted, refused } = promotionPreview({ op, body, status, contract, environment });
      preview.push({ ...receipt, would_promote: { status_codes: promoted.status_codes, fields: promoted.fields },
        would_refuse: refused, ...(drift.length ? { drift } : {}) });
      continue;
    }

    const learnedEntry = learnFromResponse({ op, method, path, body, status, contract, environment,
      sourceFile: entry.source_file, contractDigest: digest, drift, author });
    learnedEntry.last_learn = { observed_at: learnedEntry.verified_at, outcome: "verified",
      status, evidence: result.evidence, assertions: receipt.assertions };
    ctx.operations[op] = mergeVerifiedEntry(entry, learnedEntry, learnStamp);
    delete ctx.operations[op].shape_diverged_at;
    learned += 1;
  }

  if (dryRun) {
    // No saveContext or pointer refresh. Private client evidence is retained.
    const wouldPromote = preview.reduce((s, p) => s + Object.keys(p.would_promote?.fields ?? {}).length, 0);
    const wouldRefuse = preview.reduce((s, p) => s + (p.would_refuse?.length ?? 0), 0);
    const privateEvidenceRetained = preview.some(item => typeof item.evidence === "string");
    const previewPointerFiles = argv.includes("--agents") || pointerBlocksAtStart.length
      ? POINTER_FILES : [];
    const advertisementOmitted = pointerOmissions(commandResolution, previewPointerFiles);
    const targetFields = requestAttempts > 0
      ? { request_target: requestTarget(cfg) }
      : selectedRequestTargetFields([{ service: ctx.api.name, ...requestTarget(cfg) }]);
    if (asJson) {
      console.log(JSON.stringify({ dry_run: true, environment: cfg.name, base_url: base,
        ...targetFields, request_attempts: requestAttempts,
        executed: reads.length, operations: preview, private_evidence_retained: privateEvidenceRetained,
        would_promote_fields: wouldPromote, would_refuse_fields: wouldRefuse,
        pointers: previewPointerFiles.map((file) => ({ file, action: "would write" })),
        omitted: advertisementOmitted,
        command_resolution: publicCommandResolution(commandResolution),
        wrote: null, next: "Re-run without --dry-run to promote this into " + contextFile() + "." }, null, 1));
      return;
    }
    console.log(requestAttempts > 0
      ? `learn --dry-run — ${reads.length} read${reads.length === 1 ? "" : "s"} executed against ${base} (${cfg.name ?? "default"}). ` +
        `${requestTarget(cfg).base_url_source === "API_BASE_URL" ? "URL overridden by API_BASE_URL. " : ""}KNOWLEDGE AND POINTERS UNCHANGED; ${privateEvidenceRetained ? "private request evidence retained" : "no completed request evidence"}.\n`
      : `learn --dry-run — 0 reads executed. Selected ${requestTargetLine(cfg)}; no eligible GET/HEAD request was attempted. NOTHING WRITTEN.\n`);
    for (const p of preview) {
      if (p.unreachable) { console.log(`  ${p.op}\n    unreachable: ${p.unreachable}\n`); continue; }
      console.log(`  ${p.op}  [${p.status}]${p.verified === false ? ` — ${p.outcome}; unverified` : ""}`);
      const fields = Object.entries(p.would_promote.fields);
      if (fields.length) {
        console.log(`    would promote:`);
        for (const [f, e] of fields) {
          const vals = e.values ? `  values ${JSON.stringify(e.values)}${e.undeclared_count ? ` (+${e.undeclared_count} undeclared, withheld)` : ""}` : "";
          console.log(`      ${f.padEnd(20)} distinct ${e.distinct}${vals}`);
        }
      }
      if (p.would_refuse.length) {
        console.log(`    would refuse (values withheld):`);
        for (const r of p.would_refuse) console.log(`      ${r.field.padEnd(20)} ${r.reason}`);
      }
      console.log("");
    }
    if (skipped.length) {
      console.log(`Skipped ${skipped.length} operation${skipped.length === 1 ? "" : "s"} — incomplete coverage is named, not implied green.\n`);
      for (const s of skipped)
        console.log(`  ${s.op}\n    skipped: ${s.reason}\n    unblock: ${s.unblock}\n`);
    }
    for (const omission of advertisementOmitted) {
      console.log(`Omitted command from ${omission.surface}: ${omission.command}`);
      console.log(`  reason: ${omission.reason}`);
      console.log(`  remedy: ${omission.remedy}\n`);
    }
    console.log(`${wouldPromote} field${wouldPromote === 1 ? "" : "s"} would be promoted, ${wouldRefuse} refused. Re-run without --dry-run to write ${contextFile()}.`);
    return;
  }

  // A wholly dead host deposits nothing at all — not even the digest refresh.
  // CI's one lever is the exit code; a red run with the file untouched is
  // recoverable, a green run that quietly committed an empty-handed learn is
  // not. Partial reachability still deposits (the reads that ran are real) and
  // reports the unreachable count for the pipeline log.
  if (asCi && reads.length && failed === reads.length)
    die("CI_DEPOSIT_UNREACHABLE", `${base} unreachable: 0 of ${reads.length} reads executed; nothing deposited.`,
      "Start the service earlier in the pipeline, or fix this environment's baseUrl.");

  // The pointer block. Wiring stays opt-in — and passing --agents IS the
  // opt-in: create where absent, refresh where present, the same call
  // `init --agents` makes. Until 2026-08-24 the flag was ignored whenever no
  // block existed yet, so a user following doctor's own fix line ("learn
  // --agents for the pointer block alone") — or this command's own --help
  // example — got exit 0, an empty pointers_refreshed, and nothing on disk:
  // a silent green, the one thing this product exists to refuse. Without the
  // flag, today's behavior stands exactly: gotchas only exist after
  // execution, so a block already in place is refreshed, and a repo that
  // never opted in gets nothing it did not ask for.
  const refreshed = pointerBlocksAtStart;
  const wantAgents = argv.includes("--agents");
  // The flagless upsert touches EVERY pointer file once a repo has opted in
  // (the measured lesson above renderBlock: AGENTS.md alone transferred 0/4,
  // CLAUDE.md 2/2 — the pair is the mechanism), which means it can
  // MATERIALIZE a missing sibling. That stays; what could not stay is the
  // silence (QA, 2026-08-24): a CLAUDE.md someone deleted on purpose came
  // back on every flagless learn, invisibly, forever — reported only as a
  // "refresh" of the OTHER file. A file that appeared on disk gets named in
  // the JSON, so the return of it is discovered from the output, not the
  // working tree.
  const pointerPlans = wantAgents || refreshed.length
    ? planPointers(root, ctx, commandResolution) : [];
  const finalPointerConflict = pointerPlans.find(({ action }) => action === "conflict");
  if (finalPointerConflict) die("POINTER_CONFLICT",
    `${finalPointerConflict.file}: ${finalPointerConflict.reason}; no context or pointer was written.`,
    `Repair that pointer file, then re-run ${commandResolution.local.command} learn --agents.`);
  const finalTargets = [
    { surface: contextFile(), path: join(root, contextFile()) },
    ...pointerPlans.filter(({ action }) => !["unchanged", "conflict"].includes(action))
      .map(({ file, path }) => ({ surface: file, path })),
  ];
  const finalUnwritable = finalTargets.map((row) => ({ ...row,
    problem: writableDestinationProblem(row.path) })).find(({ problem }) => problem);
  if (finalUnwritable) die("WRITE_PLAN_CONFLICT",
    `${finalUnwritable.surface}: ${finalUnwritable.problem}; no context or pointer was written.`,
    `Make that project target writable, then re-run ${commandResolution.local.command} learn --agents.`);

  ctx.api.contract_digest = digest;
  try {
    saveContext(root, ctx, { expectedDigest: snapshot.digest });
  } catch (error) {
    if (error?.code !== "CONTEXT_WRITE_CONFLICT") throw error;
    die("CONTEXT_WRITE_CONFLICT", error.message,
      `Re-run ${CLI_NAME} learn against the newer ${contextFile()}; no concurrent knowledge was overwritten.`);
  }
  const actions = applyPointerPlans(pointerPlans);
  const written = wantAgents ? actions : actions.filter((a) => a.action === "created");
  const omitted = wantAgents || refreshed.length
    ? pointerOmissions(commandResolution, POINTER_FILES) : [];
  console.log(JSON.stringify({
    // The marker a pipeline greps for; its absence means a human ran this.
    ...(asCi ? { ci: true } : {}),
    wrote: join(root, contextFile()), environment: cfg.name, base_url: base,
    ...(requestAttempts > 0
      ? { request_target: requestTarget(cfg) }
      : selectedRequestTargetFields([{ service: ctx.api.name, ...requestTarget(cfg) }])),
    request_attempts: requestAttempts,
    // `pointers_refreshed` keeps meaning what it has always meant (the files
    // whose block pre-existed this run). `pointers_written` is init's exact
    // key and {file, action} vocabulary: under --agents it is the full
    // opt-in report; without the flag it appears only when a file was
    // actually CREATED — nothing created, nothing claimed.
    pointers_refreshed: refreshed,
    ...(written.length ? { pointers_written: written } : {}),
    omitted,
    command_resolution: publicCommandResolution(commandResolution),
    executed: reads.length, learned, unreachable: failed, drift_found: drifted, skipped,
    unverified: outcomes.filter(item => !item.verified).length,
    authentication_failed: outcomes.filter(item => item.outcome === "authentication_failed").length,
    operations: outcomes,
    withheld_fields: Object.values(ctx.operations).reduce((s, e) => s + (e.withheld ?? 0), 0),
    next: `${CLI_NAME} review — list learned claims that need re-checking.`,
  }, null, 1));
  if (asCi && outcomes.some(item => !item.verified)) process.exitCode = 1;
}

// --- audit -----------------------------------------------------------------
// The first thing a new adopter runs. An inventory is a list and nobody shares a
// list; the discrepancies are what get pasted into a channel.

function assertCiSummaryTarget(root, summaryPath, protectedSummaryPaths) {
  if (!summaryPath) return;
  const pathIdentity = path => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const protectedPaths = new Set([join(root, BASELINE_FILE), ...protectedSummaryPaths].map(pathIdentity));
  if (protectedPaths.has(pathIdentity(summaryPath)))
    die("SUMMARY_TARGET_PROTECTED",
      `Refusing to append a CI summary to protected audit input ${summaryPath}.`,
      `Choose a separate step-summary file; CI never edits ${contextFile()}, a declared contract, registration, or its reviewed baseline.`);
}

// Every human-readable audit row shares the text map's terminal boundary.
function auditRow(value) {
  console.log(terminalText(value));
}

/**
 * The audit of a repo that SERVES no API: what it CALLS, and who calls it.
 *
 * Grouped through footprintModel — the map's own grouping — rather than by
 * hand, so the two commands can never disagree about the same repo, which is
 * the whole reason they share findSurfaces and deriveEdges everywhere else.
 * Nothing new is detected: upstreamUrls is the scan deriveEdges already runs
 * per surface, with no service to attribute a call to, so the caller is the
 * FILE. "Something in this repo calls Stripe" sends nobody anywhere.
 */
function consumerOnlyAudit(root, { asJson, asCi, recordBaselines, reportOnly,
  summaryPath, noExec, cfg, protectedSummaryPaths = [], mcp = null }) {
  const external = upstreamUrls(root, null).map((u) => ({ from: u.file, url: u.url, via: u.file }));
  // The genuinely empty tree stays an error, with a `next` that says everything
  // that was looked for: a footprint of nothing rendered as a happy report is
  // how a mistyped path argument goes unnoticed.
  if (!external.length && !mcp?.registered)
    die("NO_API_FOUND", `No API surface found under ${terminalText(root)}.`,
      emptyApiDiscoveryNext());

  // No surfaces means no findings, and that is an answer rather than a special
  // case: --ci judges zero findings against the committed baseline exactly as
  // it judges any repo's, and --baseline records that nothing is accepted yet.
  const selectedTarget = usableRequestConfig(cfg) ? requestTarget(cfg) : null;
  if (asCi) return ciReport(root, [], { asJson, reportOnly, summaryPath,
    freshness: [], noExecute: noExec, protectedSummaryPaths,
    selectedRequestTarget: selectedTarget, mcp, allowMcpBaseline: !external.length });
  const baselineWrote = recordBaselines ? writeBaselineFile(root, []) : null;
  retainAuditView(root, [], { noExecute: true, freshness: [] });

  if (asJson) {
    console.log(JSON.stringify({ root,
      ...(selectedTarget ? { selected_request_target: selectedTarget, request_execution: false } : {}),
      surfaces: [], edges: [], external, platform: [],
      ...(baselineWrote ? { baseline_written: baselineWrote, baseline_findings: 0 } : {}) }, null, 2));
    return;
  }

  const grouped = footprintModel({ root, surfaces: [], edges: [], external, platform: [] }).external;
  const w = Math.max(8, ...grouped.map((g) => g.host.length));
  console.log(`API audit — ${terminalText(root)}${selectedTarget
    ? `\n  selected ${terminalText(requestTargetLine(cfg))} (not executed)` : ""}\n`);
  console.log(`  0 API surfaces   ${grouped.length} external dependenc${grouped.length === 1 ? "y" : "ies"}` +
    `   (this repo calls APIs; it serves none)\n`);
  console.log(`  external dependencies, and the files that call them:\n`);
  for (const g of grouped)
    auditRow(`    ${g.host.padEnd(w)}  ← ${g.callers.slice(0, 4).join(", ")}` +
      (g.callers.length > 4 ? `  …+${g.callers.length - 4} more` : ""));
  // What CANNOT happen here, said once, so the reader does not go looking for
  // the drift table this report does not have.
  console.log(`\n  nothing was executed: with no contract of its own there is no server to check one against.`);
  auditRow(`  ${CLI_NAME} map ${root === process.cwd() ? "." : root} — the same footprint as a file you can share.`);
  if (baselineWrote)
    auditRow(`  baseline written: ${terminalText(baselineWrote)} — 0 findings, so audit --ci stays green until this repo serves something.`);
}

async function cmdAudit(argv) {
  const selected = requestArgs(argv, "audit", {
    booleans: ["--json", "--no-execute", "--ci", "--report-only", "--baseline", "--include-fixtures"],
    values: ["--summary"],
  });
  argv = selected.args;
  const asJson = argv.includes("--json");
  const noExec = argv.includes("--no-execute");
  const asCi = argv.includes("--ci");
  const reportOnly = argv.includes("--report-only");
  const summaryFlag = flagValue(argv, "--summary");
  const recordBaselines = argv.includes("--baseline");
  if (summaryFlag === null)
    die("MISSING_SUMMARY_PATH", "--summary needs a file path.",
      `${CLI_NAME} audit . --ci --report-only --summary \$GITHUB_STEP_SUMMARY`);
  if (!asCi && (reportOnly || summaryFlag !== undefined))
    die("CI_FLAG_REQUIRED", "--report-only and --summary are CI reporting modes and require --ci.",
      `${CLI_NAME} audit . --ci --report-only --summary <path>`);
  if (asCi && recordBaselines)
    die("CI_AND_BASELINE",
      "--baseline accepts the current findings; --ci judges against what was accepted. One run cannot do both.",
      "Run audit --baseline once, commit the file, then run audit --ci in the pipeline.");
  const positional = argv.filter((a, index) => !a.startsWith("-") && a !== "audit"
    && argv[index - 1] !== "--summary");
  const target = positional[0] ?? process.cwd();
  const root = resolve(target);
  const surfaces = findSurfaces(root, { includeFixtures: argv.includes("--include-fixtures") });
  const surfaceConfigs = preflightSurfaceEnvironment(surfaces, selected.environment);
  const selectedTargets = configuredSurfaceTargets(surfaces, surfaceConfigs);
  const cfg = surfaceConfigs[0]?.cfg ?? (selected.environment !== undefined
    ? selectRequestConfig(root, selected.environment) : resolveConfig(root));
  const summaryPath = summaryFlag === undefined ? null : resolve(summaryFlag);
  const protectedSummaryPaths = surfaces.flatMap((surface) => [
    join(surface.dir, contextFile(surface.dir)),
    ...(surface.contract ? [surface.contract] : []),
  ]);
  protectedSummaryPaths.push(join(root, contextFile()), ...[
    ".mcp.json", ".codex/config.toml", ".cursor/mcp.json", ".vscode/mcp.json",
  ].map(file => join(root, file)));
  if (asCi) assertCiSummaryTarget(root, summaryPath, protectedSummaryPaths);
  const mcp = asCi ? await auditMcpDeclarations(root) : null;

  // THE CONSUMER-ONLY REPO — the same rule map follows, one command over.
  // findSurfaces answers "what does this tree SERVE", and for a frontend, a
  // worker or a CLI the answer is nothing, while the third-party surface it
  // depends on and nobody has inventoried sits right there in the source. Half
  // the repos in a real personal tree are that shape, and exit 1 is the wrong
  // answer to the right question — worse here than in map, because the reader
  // arrives at audit from a map that just rendered the same repo happily.
  if (!surfaces.length) return consumerOnlyAudit(root,
    { asJson, asCi, recordBaselines, reportOnly, summaryPath, noExec,
      protectedSummaryPaths, cfg, mcp });

  const results = [];
  for (const s of surfaces) results.push(await auditSurface(s, { execute: !noExec, recordBaselines }));

  const { edges, external } = deriveEdges(results);

  // Cross-repo body drift: an upstream field went required and the consumer's
  // repo never got a commit. Needs the whole result set (consumer call site +
  // upstream contract + upstream server), so it runs after the per-surface pass.
  if (!noExec) await crossRepoRequiredFieldFindings(results, { readContract, baseUrlFor, upstreamUrls });

  // Consistency ACROSS services, scoped to a platform: one repo, or services
  // joined by derived call edges. Unrelated repos are never compared (the within-repository convention rule;
  // — two products disagreeing is not drift, it is two products).
  const platform = platformConsistency(results, edges);

  // Severity travels ON each finding from here down, so the JSON, the report,
  // the baseline and the CI diff cannot rank the same finding differently.
  const rank = { high: 0, medium: 1, low: 2 };
  for (const r of results) {
    for (const f of r.findings) f.severity = severityFor(f);
    r.findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
    for (const s of r.shadowRoutes ?? [])
      if (!s.infra) s.severity = severityFor({ kind: "shadow-route", op: `${s.method} ${s.path}` });
  }
  const ranked = ciFindings(results, platform);
  const targetFields = requestEvidenceFields(results, selectedTargets);

  if (asCi) return ciReport(root, ranked, { asJson, reportOnly, summaryPath,
    freshness: auditFreshness(results), noExecute: noExec, protectedSummaryPaths,
    requestTargets: targetFields, mcp });

  // --baseline: the current findings become the accepted state, in a file meant
  // to be committed — accepted debt stays visible in review, and --ci goes red
  // only when someone adds to it.
  const baselineWrote = recordBaselines ? writeBaselineFile(resolve(target), ranked) : null;
  retainAuditView(root, ranked, { noExecute: noExec, freshness: auditFreshness(results),
    basis: auditViewBasis(results) });

  if (asJson) { console.log(JSON.stringify({ root: resolve(target), ...targetFields,
    surfaces: results, edges, external, platform,
    ...(baselineWrote ? { baseline_written: baselineWrote, baseline_findings: ranked.length } : {}) }, null, 2)); return; }

  const documented = results.filter((r) => r.kind === "documented");
  const undocumented = results.filter((r) => r.kind === "undocumented");
  const totalOps = documented.reduce((n, r) => n + r.declared, 0);
  const totalRoutes = undocumented.reduce((n, r) => n + r.routes, 0);
  const allFindings = results.flatMap((r) => r.findings.map((f) => ({ ...f, service: r.name })));
  const probedCount = results.reduce((n, r) => n + r.checked, 0);
  const attemptedCount = results.reduce((n, r) => n + (r.attempted ?? 0), 0);

  console.log(`API audit — ${terminalText(resolve(target))}\n`);
  for (const target of targetFields.request_targets ?? [])
    auditRow(`  ${target.service ? `${target.service}: ` : ""}environment '${target.environment ?? "unnamed"}' — ${target.base_url}` +
      (target.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : ""));
  const selectedRows = targetFields.selected_request_targets
    ?? (targetFields.selected_request_target ? [targetFields.selected_request_target] : []);
  for (const selectedTarget of selectedRows)
    auditRow(`  selected ${selectedTarget.service ? `${selectedTarget.service}: ` : ""}` +
      `environment '${selectedTarget.environment ?? "unnamed"}' — ${selectedTarget.base_url} (not executed)` +
      (selectedTarget.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : ""));
  auditRow("");
  auditRow(`  ${results.length} API surfaces   ${totalOps} documented operations` +
              (totalRoutes ? `   ${totalRoutes} undocumented routes` : ""));
  if (probedCount) auditRow(`  ${attemptedCount} request${attemptedCount === 1 ? "" : "s"} attempted, ` +
    `${probedCount} received a response   ${allFindings.length} disagreements between contract and server`);
  else if (attemptedCount) auditRow(`  ${attemptedCount} request${attemptedCount === 1 ? "" : "s"} attempted; no HTTP response received`);
  else auditRow(`  nothing executed (no eligible configured GET/HEAD operation)`);
  auditRow("");

  const pad = Math.max(...results.map((r) => r.name.length), 8);
  // The repo column is here so a surface that lives in a checkout of its own is
  // visible as such. The audit reports where the code sits and who commits to
  // it; deciding whether that makes it yours is the reader's call, not a guess.
  const rpad = Math.max(...results.map((r) => (r.repo ?? "not in git").length), 4);
  auditRow(`  ${"service".padEnd(pad)}  ops  state        ${"repo".padEnd(rpad)}  owner`);
  auditRow(`  ${"-".repeat(pad)}  ---  -----------  ${"-".repeat(rpad)}  -----`);
  for (const r of results.sort((a, b) => (b.declared ?? b.routes) - (a.declared ?? a.routes))) {
    const ops = String(r.declared ?? r.routes).padStart(3);
    const state = r.kind === "undocumented" ? "no contract"
      : r.findings.length ? `${r.findings.length} disagree`
      : r.reachable === null ? "not probed" : "agrees";
    auditRow(`  ${r.name.padEnd(pad)}  ${ops}  ${state.padEnd(11)}  ${(r.repo ?? "not in git").padEnd(rpad)}  ${r.owner ?? "unknown"}${r.ownerSource ? `  (${r.ownerSource})` : ""}`);
  }

  if (allFindings.length) {
    // Severity-ordered, worst first: the reader who stops after three lines
    // stops after the three that matter most.
    allFindings.sort((a, b) => rank[a.severity] - rank[b.severity]);
    console.log(`\n  where the contract and the server disagree:\n`);
    for (const f of allFindings.slice(0, 25))
      auditRow(`    ${f.severity.padEnd(6)}  ${f.service.padEnd(pad)}  ${f.op.padEnd(26)} ${f.detail}`);
    if (allFindings.length > 25) auditRow(`    …and ${allFindings.length - 25} more`);
  }

  // One platform, several conventions: the drift no single service can see.
  if (platform.length) {
    console.log(`\n  where one platform follows several conventions:\n`);
    for (const p of platform)
      auditRow(`    ${p.dimension.padEnd(pad)}  ${p.detail}`);
  }

  if (undocumented.length) {
    console.log(`\n  services with routes but no contract:\n`);
    for (const u of undocumented)
      auditRow(`    ${u.name.padEnd(pad)}  ~${u.routes} routes  (${u.framework})`);
  }

  // Live routes a documented service's own spec never declares. Listed loudly
  // and last, because a debug or admin route hiding inside a service that looks
  // fully documented is the finding most worth acting on.
  const shadow = results.flatMap((r) => (r.shadowRoutes ?? []).filter((s) => !s.infra).map((s) => ({ ...s, svc: r.name })));
  if (shadow.length) {
    shadow.sort((a, b) => rank[a.severity] - rank[b.severity]);
    console.log(`\n  undocumented routes live in documented services (${shadow.length}):\n`);
    for (const s of shadow.slice(0, 25))
      auditRow(`    ${s.severity.padEnd(6)}  ${s.svc.padEnd(pad)}  ${`${s.method} ${s.path}`.padEnd(30)} ${s.file}`);
    if (shadow.length > 25) auditRow(`    …and ${shadow.length - 25} more`);
  }

  // The neighborhood: one hop out, derived not declared (derived call edges). This is
  // what turns the inventory into a map — and what makes cross-repo drift
  // legible, since an edge is exactly a place an upstream can change without a
  // commit landing in the consumer.
  if (edges.length) {
    console.log(`\n  service dependencies (derived from source):\n`);
    for (const e of edges) {
      auditRow(`    ${e.from.padEnd(pad)} → ${e.to.padEnd(pad)}  (${e.via})`);
      // The operations make the edge actionable: which declared surface the
      // consumer actually leans on, and which calls the upstream never
      // declared at all — an unmatched call is an undocumented dependency.
      if (e.operations?.length)
        auditRow(`    ${"".padEnd(pad)}   calls ${e.operations.length} declared op${e.operations.length === 1 ? "" : "s"}: ${e.operations.join(", ")}`);
      if (e.unmatchedCalls?.length)
        auditRow(`    ${"".padEnd(pad)}   ${e.unmatchedCalls.length} call${e.unmatchedCalls.length === 1 ? "" : "s"} the upstream contract never declares: ${e.unmatchedCalls.join(", ")}`);
    }
  }
  if (external.length) {
    const seen = new Set();
    const uniq = external.filter((e) => { const k = `${e.from}→${e.url}`; return seen.has(k) ? false : seen.add(k); });
    console.log(`\n  external upstreams (not one of these services):\n`);
    for (const e of uniq.slice(0, 15))
      auditRow(`    ${e.from.padEnd(pad)} → ${e.url}`);
    if (uniq.length > 15) auditRow(`    …and ${uniq.length - 15} more`);
  }

  if (surfaces.excluded?.length)
    console.log(`\n  ${surfaces.excluded.length} surface(s) excluded as fixtures or examples. --include-fixtures to show them.`);

  const noContext = results.filter((r) => !r.hasContext).length;
  console.log(`\n  ${results.length - noContext}/${results.length} services have ${contextFile()}.` +
              (noContext ? `  Run ${CLI_NAME} init --agents in the rest.` : ""));

  if (baselineWrote) {
    const by = ranked.reduce((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
    console.log(`\n  baseline written: ${terminalText(baselineWrote)}`);
    auditRow(`  ${ranked.length} finding${ranked.length === 1 ? "" : "s"} accepted` +
      ` (${by.high ?? 0} high, ${by.medium ?? 0} medium, ${by.low ?? 0} low).` +
      `  Commit it; audit --ci fails only on findings it has never seen.`);
  }
}

// --- map -------------------------------------------------------------------
// The audit's derived graph as a shareable artifact (PRD A1): the day-one
// value, before anything accumulates. Same pipeline as the audit — findSurfaces,
// auditSurface, deriveEdges, platformConsistency — so the map can never show a
// graph the audit would not; all rendering lives in lib/map.mjs. Default is
// the self-contained HTML file (a map is a thing you open and paste into a
// channel); --text keeps it in the terminal, --json feeds machines. The HTML
// is written to the surveyed project directory (or --out). All modes retain the
// projected model in the surveyed project's evidence directory for view.

// Public graph failures are an explicit allowlist with fixed guidance. A raw
// filesystem message or invented prefixed code can contain workstation data.
const GRAPH_COMMAND_FAILURES = Object.fromEntries([
  ...['GRAPH_INPUT_INVALID', 'GRAPH_INPUT_BOUNDS', 'GRAPH_VERSION_UNSUPPORTED',
    'GRAPH_REPOSITORY_ID_INVALID', 'GRAPH_TEXT_CONTROL_REFUSED', 'GRAPH_PUBLISHER_CONFLICT',
    'GRAPH_OWNERSHIP_INVALID', 'GRAPH_OWNERSHIP_CONFLICT', 'GRAPH_NODE_MISSING',
    'GRAPH_EDGE_CONFLICT', 'GRAPH_KNOWLEDGE_CONFLICT', 'GRAPH_MANIFEST_TOO_LARGE']
    .map(code => [code, ['The graph manifest or snapshot does not meet the supported format.',
      'Preserve the existing files and repair the named graph configuration problem. See docs/dependency-graph.md.']]),
  ...['GRAPH_CONTEXT_INVALID', 'GRAPH_CONTEXT_CHANGED', 'GRAPH_CONTEXT_READ_FAILED',
    'GRAPH_CONTEXT_INPUT_BOUNDS', 'GRAPH_CONTEXT_INPUT_CHANGED', 'GRAPH_CONTEXT_PATH_REFUSED', 'GRAPH_CONTEXT_SECRET_REFUSED']
    .map(code => [code, ['The saved graph context could not be exported safely.',
      'Preserve the saved context and inspect its format, repository-relative references and metadata. Remove workstation paths and credential values before retrying.']]),
  ...['GRAPH_CATALOG_INVALID', 'GRAPH_CATALOG_BOUNDS', 'GRAPH_CATALOG_CHANGED', 'GRAPH_CATALOG_UNREADABLE', 'GRAPH_SYMLINK_REFUSED']
    .map(code => [code, ['The selected graph catalog could not be read safely.',
      'Choose bounded regular snapshot files with unlinked directory ancestors and repair the named catalog problem. See docs/dependency-graph.md.']]),
  ...['GRAPH_SNAPSHOT_DESTINATION_REFUSED', 'GRAPH_SNAPSHOT_DESTINATION_CHANGED']
    .map(code => [code, ['The graph snapshot destination was refused; existing files were preserved.',
      `Choose a new regular snapshot file or an existing snapshot from this publisher. Never use ${contextFile()}, the graph manifest, an unrelated file, or a linked destination. Retry graph export --out with the corrected destination.`]]),
  ['GRAPH_SNAPSHOT_TOO_LARGE', ['The graph snapshot exceeds the supported output size.',
    'Review export omissions and reduce the selected graph context before retrying. Preserve the existing snapshot.']],
  ['GRAPH_NOT_CONFIGURED', ['This repository has no graph manifest.',
    'Configure the local graph manifest with explicit repository identity and graph bindings. See docs/dependency-graph.md.']],
  ['GRAPH_QUERY_INVALID', ['The graph query does not match the supported query format.',
    'Use an exact graph node with optional operation and environment filters, and a byte budget from 2000 to 64000. See docs/dependency-graph.md.']],
  ...['GRAPH_NODE_NOT_FOUND', 'GRAPH_RECORD_NOT_FOUND', 'GRAPH_RECORD_REF_AMBIGUOUS', 'GRAPH_CONTEXT_BINDING_AMBIGUOUS']
    .map(code => [code, ['The selected graph identity is absent or ambiguous.',
      'Inspect the selected snapshot identities and use one exact node or record reference. Preserve the published records.']]),
  ...['GRAPH_CONTEXT_UNAVAILABLE', 'GRAPH_CONTEXT_OUTPUT_BOUNDS']
    .map(code => [code, ['The configured graph context is unavailable within the supported bounds.',
      'Inspect the selected graph snapshots and use a narrower query or a larger supported byte budget. See docs/dependency-graph.md.']]),
  ['CONTEXT_WRITE_LOCKED', ['The graph export could not acquire the context write lock.',
    'Allow the current context writer to finish, then retry the export. Preserve existing context and snapshot files.']],
  ['OUTPUT_OUTSIDE_PROJECT', ['The graph snapshot destination is outside the project.',
    'Choose a project-local snapshot destination, or add --allow-outside-project for this destination.']],
  ['OUTPUT_UNSAFE_PATH', ['The graph snapshot destination could not be used safely.',
    'Choose a regular snapshot file with unlinked directory ancestors. Preserve existing files.']],
  ['GRAPH_FAILED', ['The graph command could not complete.',
    'Preserve the local context and snapshots, inspect the graph configuration and filesystem access, and retry after resolving the local issue. See docs/dependency-graph.md.']],
]);

async function graphCliFailure(error, { record = false } = {}) {
  const { graphRecordFailure } = await import("../lib/graph-record.mjs");
  const recorded = graphRecordFailure(error).error;
  if (record || recorded.code !== "GRAPH_RECORD_FAILED")
    return { code: recorded.code, message: recorded.message, next: recorded.remediation };
  const code = Object.hasOwn(GRAPH_COMMAND_FAILURES, error?.code) ? error.code : "GRAPH_FAILED";
  const [message, next] = GRAPH_COMMAND_FAILURES[code];
  return { code, message, next };
}

async function cmdGraph(argv) {
  const action = argv[1] ?? "context";
  const argumentHelp = "Review the graph command help and supported arguments in docs/dependency-graph.md.";
  const allowed = {
    export: new Set(["--manifest", "--out", "--json", "--allow-outside-project"]),
    record: new Set(["--operation", "--note", "--environment", "--protocol", "--observation-id", "--operation-id", "--json"]),
    context: new Set(["--catalog", "--operation", "--environment", "--max-bytes", "--json", "--include-foreign-claims"]),
    impact: new Set(["--catalog", "--environment", "--max-bytes", "--json", "--include-foreign-claims"]),
    stats: new Set(["--json"]),
  };
  if (!Object.hasOwn(allowed, action)) die("GRAPH_ARGUMENT_INVALID", "Unknown graph action.", argumentHelp);
  const flags = {}, positional = [];
  for (let i = 2; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("-")) { positional.push(value); continue; }
    const equal = value.indexOf("="), key = equal < 0 ? value : value.slice(0, equal);
    if (!allowed[action].has(key) || Object.hasOwn(flags, key))
      die("GRAPH_ARGUMENT_INVALID", "Unknown or repeated graph option.", argumentHelp);
    if (["--json", "--allow-outside-project", "--include-foreign-claims"].includes(key)) {
      if (equal >= 0) die("GRAPH_ARGUMENT_INVALID", "This graph flag takes no value.", argumentHelp);
      flags[key] = true;
    } else {
      const argument = equal < 0 ? argv[++i] : value.slice(equal + 1);
      if (!argument || argument.startsWith("--")) die("GRAPH_ARGUMENT_INVALID", "A graph option needs a value.", argumentHelp);
      flags[key] = argument;
    }
  }
  if (positional.length > (action === "stats" ? 0 : 1) || action === "impact" && !positional.length
    || action === "record" && !positional.length && !flags["--observation-id"])
    die("GRAPH_ARGUMENT_INVALID", "Provide one graph node for impact, or an optional node for context.", argumentHelp);
  try {
    const root = action === "export" && positional[0] ? resolve(positional[0]) : repoRoot();
    if (action === "record") {
      const { recordGraphContext } = await import("../lib/graph-record.mjs");
      const result = recordGraphContext(root, { ...(positional[0] ? { node: positional[0] } : {}),
        ...(flags["--operation"] ? { operation: flags["--operation"] } : {}), note: flags["--note"],
        ...(flags["--observation-id"] ? { observation_id: flags["--observation-id"] } : {}),
        ...(flags["--operation-id"] ? { operation_id: flags["--operation-id"] } : {}),
        ...(flags["--environment"] ? { environment: flags["--environment"] } : {}),
        ...(flags["--protocol"] ? { protocol: flags["--protocol"] } : {}) });
      console.log(flags["--json"] ? JSON.stringify(result, null, 2)
        : `API lesson saved as an authored claim in ${contextFile()}.\n${result.next}`);
      if (['failed', 'limited'].includes(result.snapshot?.state)) process.exitCode = 1;
      return;
    }
    if (action === "export") {
      const { exportGraphSnapshot } = await import("../lib/graph-export.mjs");
      const { writeGraphSnapshot } = await import("../lib/graph-snapshot-write.mjs");
      const out = resolve(flags["--out"] ?? join(root, LAYOUT.graphSnapshot));
      const { snapshot } = writeGraphSnapshot(root, out,
        () => exportGraphSnapshot(root, { manifestPath: flags["--manifest"] }),
        { manifestPath: flags["--manifest"], allowOutside: Boolean(flags["--allow-outside-project"]) });
      const receipt = { path: out, repository: snapshot.repository.id, nodes: snapshot.nodes.length,
        dependencies: snapshot.edges.length, knowledge: snapshot.knowledge.length,
        omissions: snapshot.omissions, requests_executed: 0, published: false };
      console.log(flags["--json"] ? JSON.stringify(receipt, null, 2)
        : `Graph snapshot written: ${out}\n${receipt.nodes} nodes, ${receipt.dependencies} declared dependencies, ${receipt.knowledge} context records.\nLocal export only; no API requests or remote publication.`);
      return;
    }
    const { graphContext, readGraphUsage } = await import("../lib/agent-graph-context.mjs");
    if (action === "stats") {
      console.log(JSON.stringify(await readGraphUsage(root), null, 2));
      return;
    }
    const result = await graphContext(root, { action: action === "impact" ? "impact" : "context",
      ...(flags["--include-foreign-claims"] ? { include_foreign_claims: true } : {}),
      ...(positional[0] ? { node: positional[0] } : {}),
      ...(flags["--operation"] ? { operation: flags["--operation"] } : {}),
      ...(flags["--environment"] ? { environment: flags["--environment"] } : {}),
      ...(flags["--max-bytes"] ? { max_bytes: Number(flags["--max-bytes"]) } : {}) },
    { catalogPath: flags["--catalog"] ? resolve(flags["--catalog"]) : undefined, channel: "cli" });
    if (!result.ok) {
      const issues = await Promise.all((result.issues?.length ? result.issues : [{}]).map(issue => graphCliFailure(issue)));
      console.log(flags["--json"] ? JSON.stringify({ ...result, issues }, null, 2)
        : issues.map(issue => `${issue.code}: ${issue.message}\n${issue.next}`).join("\n\n"));
      process.exitCode = 1;
      return;
    }
    const compactFacts = (result.knowledge ?? []).some(item => item.notes?.some(note => !result.briefing.includes(note)))
      ? `\n\nSaved context:\n${JSON.stringify(result.knowledge, null, 2)}` : "";
    const foreignFacts = result.foreign_claims?.length
      ? `\n\nClaims about foreign nodes (external-claim, unverified):\n${JSON.stringify(result.foreign_claims, null, 2)}` : "";
    const diagnostics = (result.issues ?? []).map(issue => `\n${terminalText(issue.code)}${issue.file ? ` (${terminalText(issue.file)})` : ""}${issue.publisher ? ` (${terminalText(issue.publisher)})` : ""}: ${terminalText(issue.message)}`).join("");
    console.log(flags["--json"] ? JSON.stringify(result, null, 2) : result.briefing + compactFacts + foreignFacts + diagnostics);
  } catch (error) {
    const { code, message, next } = await graphCliFailure(error, { record: action === "record" });
    die(code, message, next);
  }
}

async function cmdMap(argv) {
  const selected = requestArgs(argv, "map", {
    booleans: ["--json", "--text", "--execute", "--no-execute", "--include-fixtures", "--preview", "--no-preview", "--allow-outside-project"],
    values: ["--out", "--catalog"],
  });
  argv = selected.args;
  const outFlag = flagValue(argv, "--out");
  const catalogFlag = flagValue(argv, "--catalog");
  if (outFlag === null)
    die("MISSING_OUT_PATH", "--out needs a file path.", `${CLI_NAME} map . --out footprint.html`);
  if (catalogFlag === null)
    die("GRAPH_ARGUMENT_INVALID", "--catalog needs a snapshot file or directory.", `${CLI_NAME} map --help`);
  const positional = argv.filter((a, i) => !a.startsWith("-") && a !== "map" && !["--out", "--catalog"].includes(argv[i - 1]));
  const target = positional[0] ?? process.cwd();
  const asJson = argv.includes("--json");
  const asText = argv.includes("--text");
  const noExec = !argv.includes("--execute") || argv.includes("--no-execute");

  const root = resolve(target);
  let out;
  if (!asJson && !asText) {
    try {
      if (!outFlag) planLayout(root);
      out = resolveOutputPath(root, outFlag ?? join(root, LAYOUT.mapOutput),
        { allowOutside: argv.includes("--allow-outside-project") });
    } catch (error) {
      if (error?.code === "OUTPUT_OUTSIDE_PROJECT")
        die("OUTPUT_OUTSIDE_PROJECT", "The map destination is outside the project.",
          "Choose a project-local output path, or add --allow-outside-project for this destination.");
      die("OUTPUT_UNSAFE_PATH", "The map destination could not be used safely.",
        "Choose a regular, single-link output file with unlinked parent directories.");
    }
  }
  const terminalLines = value => String(value).split("\n").map(line => {
    const escaped = terminalText(line);
    return escaped.length > 1024 ? `${escaped.slice(0, 1023)}…` : escaped;
  }).join("\n");
  let graph;
  if (catalogFlag !== undefined || existsSync(join(root, LAYOUT.graphManifest))) {
    try {
      const { graphContext } = await import("../lib/agent-graph-context.mjs");
      graph = await graphContext(root, { action: "overview", max_bytes: 64000 },
        { catalogPath: catalogFlag ? resolve(catalogFlag) : undefined, channel: "map" });
      if (!graph.ok) throw Object.assign(new Error("Graph context unavailable."), { code: graph.issues[0]?.code });
    } catch (error) {
      const { code, message, next } = await graphCliFailure(error);
      die(code, message, next);
    }
  }
  const surfaces = findSurfaces(root, { includeFixtures: argv.includes("--include-fixtures") });
  const surfaceConfigs = preflightSurfaceEnvironment(surfaces, selected.environment);
  const selectedTargets = configuredSurfaceTargets(surfaces, surfaceConfigs);
  const cfg = surfaceConfigs[0]?.cfg ?? (selected.environment !== undefined
    ? selectRequestConfig(root, selected.environment) : resolveConfig(root));
  const mapExecution = noExec ? null : await (await import("../lib/map-execution.mjs")).executeMapReads(root, {
    command: "map", environment: selected.environment, includeFixtures: argv.includes("--include-fixtures"),
  });
  // The store's API map: what this repository's knowledge store and its
  // contract hold, projected without executing anything. It appears only when
  // the store has operations; every other repository gets exactly the
  // footprint it always got.
  // The API map never costs the footprint: if the section cannot be built, or
  // its final scan finds a value withholding missed, only the section is
  // dropped, with a named note, and the footprint is still written. Values the
  // secret scan flags are withheld inside the map (they read "withheld" and
  // are counted), so that final scan reads what would be rendered: the HTML
  // fragment, the terminal summary and the JSON summary.
  let apiMap = null, apiMapDropped = false;
  try {
    const built = buildApiMapModel(root, { environment: selected.environment, learnedReasons: false });
    if (built.kind === "stack-api-map" || (built.state === "mapped" && built.store_operations > 0)) {
      if ([renderApiMapHtml(built), renderApiMapText(built), JSON.stringify(apiMapSummary(built))].some(secretOnPage))
        throw Object.assign(new Error("A value withholding missed reached the API map."), { code: "API_MAP_WITHHOLDING_MISSED" });
      apiMap = built;
    }
  } catch (error) {
    apiMapDropped = true;
    const reason = ["API_MAP_WITHHOLDING_MISSED", "API_MAP_CONTEXT_INVALID"].includes(error?.code) ? error.code : "API_MAP_BUILD_FAILED";
    console.error(JSON.stringify({ code: "API_MAP_UNAVAILABLE", reason,
      message: reason === "API_MAP_WITHHOLDING_MISSED"
        ? "A secret-shaped value reached the API map after withholding (a withholding bug); the section was omitted and the footprint below was written."
        : "The knowledge store's API map could not be built; the footprint below omits it." }));
  }
  let model;
  try {
    model = await buildMapModel(root, {
      execute: false,
      includeFixtures: argv.includes("--include-fixtures"),
    });
  } catch (error) {
    // A repository that serves nothing and names no outbound call can still
    // hold a store of what it consumes; that store is the map. A store whose
    // map was dropped above still gets its (empty) footprint and exit 0.
    if (error?.code === "NO_API_FOUND" && (graph || apiMap || apiMapDropped))
      model = footprintModel({ root, surfaces: [], edges: [], external: [], platform: [] });
    else if (error?.code === "NO_API_FOUND") die(error.code, error.message, error.next);
    else throw error;
  }

  if (mapExecution) model = { ...model, probe_execution: "executed", map_execution: mapExecution };
  const executedTargets = mapExecution?.requests.filter(row => row.attempts > 0).map(row => ({
    service: row.stack ?? row.service, environment: row.environment, base_url: row.base_url, base_url_source: row.base_url_source,
  })) ?? [];
  const modelTargets = executedTargets.length ? [...new Map(executedTargets.map(row => [JSON.stringify(row), row])).values()] : model.services.flatMap((service) => service.request_target
    ? [{ service: service.name, ...service.request_target }] : []);
  const targetFields = modelTargets.length ? requestTargetFields(modelTargets)
    : selectedRequestTargetFields(selectedTargets);
  const { readSurvey } = await import('../lib/survey.mjs');
  model = { ...model, ...targetFields, ...(graph ? { graph } : {}), survey: readSurvey(root) };
  retainViewModel(root, "map", model, { basis: noExec
    ? "Static map from source declarations; no API requests executed"
    : "Map from source declarations and recorded client responses; only requested operations have execution evidence" });
  if (asJson) { console.log(JSON.stringify(apiMap ? { ...model, api_map: apiMapSummary(apiMap) } : model, null, 2)); return; }
  if (asText) {
    const targetLines = (targetFields.request_targets ?? []).map((target) =>
      `${target.service ? `${target.service}: ` : ""}environment '${target.environment ?? "unnamed"}' — ${target.base_url}` +
      (target.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : ""));
    for (const selectedTarget of targetFields.selected_request_targets
      ?? (targetFields.selected_request_target ? [targetFields.selected_request_target] : []))
      targetLines.push(`selected ${selectedTarget.service ? `${selectedTarget.service}: ` : ""}` +
        `environment '${selectedTarget.environment ?? "unnamed"}' — ${selectedTarget.base_url} (not executed)`);
    console.log(renderMapText(model, { apiMap }) + (apiMap ? `\n\n${renderApiMapText(apiMap)}` : "") +
      (graph ? `\n\n${terminalLines(graph.briefing)}` : "") +
      (selected.environment !== undefined || cfg.baseUrlOverride ? `\n\n${targetLines.map(terminalText).map(terminalLines).join("\n")}` : ""));
    return;
  }

  let html = renderMapHtml(model, { apiMap });
  if (model.survey.state === 'ready') {
    const { renderSurveySection } = await import('../lib/survey-render.mjs');
    html = html.replace('</body>', `${renderSurveySection(model.survey.snapshot, { status: model.survey.status })}</body>`);
  } else {
    html = html.replace('</body>', `<section data-survey-state="${model.survey.state}"><h2>API survey</h2><p>Survey ${model.survey.state === 'not-generated' ? 'not generated' : 'unavailable: invalid snapshot'}. Generate explicitly with the survey generate command; no discovery was triggered by this reader.</p></section></body>`);
  }
  if (graph) {
    const { decorateGraphMapHtml } = await import("../lib/graph-map.mjs");
    html = decorateGraphMapHtml(html, graph);
  }
  if (!outFlag) ensureLayout(root);
  mkdirSync(dirname(out), { recursive: true });
  writeOutputFile(out, html);
  let preview, previewFailed = false;
  if (argv.includes("--preview") && !argv.includes("--no-preview")) {
    try {
      const { startMapPreview } = await import("../lib/map-preview.mjs");
      preview = await startMapPreview(html);
    } catch { previewFailed = true; }
  }
  console.log(renderMapReceipt(model, { out, preview, previewFailed, noExecute: noExec, apiMap }));
  if (selected.environment !== undefined || cfg.baseUrlOverride)
    for (const target of targetFields.request_targets ?? [])
      console.log(terminalLines(terminalText(`  ${target.service ? `${target.service}: ` : ""}environment '${target.environment ?? "unnamed"}' — ${target.base_url}` +
        (target.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : ""))));
}

// --- view ------------------------------------------------------------------
async function cmdView(argv) {
  const { buildViewModel, renderViewHtml } = await import("../lib/view.mjs");
  const root = repoRoot();
  let outFlag;
  const flags = new Set(["--json", "--open", "--execute", "--no-execute", "--allow-outside-project"]);
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--out") {
      if (outFlag !== undefined || !argv[i + 1] || argv[i + 1].startsWith("-"))
        die("MISSING_OUT_PATH", "--out needs one file path.", `${CLI_NAME} view --out evidence/view/index.html`);
      outFlag = argv[++i];
    } else if (!flags.has(argv[i])) die("UNKNOWN_FLAG", "Unrecognized view argument.", `${CLI_NAME} view --help`);
  }
  const allowOutside = argv.includes("--allow-outside-project");
  let out, model, mapExecution;
  try {
    out = resolveOutputPath(root, resolve(outFlag ?? join(evidenceDirectory(root), "view", "index.html")), { allowOutside, fileOnly: true });
    if (argv.includes("--execute") && !argv.includes("--no-execute"))
      mapExecution = await (await import("../lib/map-execution.mjs")).executeMapReads(root, { command: "view" });
    model = buildViewModel(root);
    writeViewFile(root, out, renderViewHtml(model), { allowOutside });
  } catch (error) {
    // Content never refuses the page: values are withheld where they would
    // render. VIEW_WITHHOLDING_MISSED is the last guard finding a value that
    // withholding missed, a bug; it names the section and never the value.
    const missed = error.code === "VIEW_WITHHOLDING_MISSED";
    console.error(JSON.stringify({ code: error.code ?? "VIEW_WRITE_FAILED",
      message: missed ? error.message : error.code === "VIEW_SECRET_REFUSED" ? "A secret-shaped value was found; nothing was written." : "Could not render the snapshot; no page was written.",
      ...(missed ? { section: error.section } : {}),
      next: missed ? "Report this withholding bug with the section name; the page was not written." : "Check the named input or choose a regular project-local output file." }));
    process.exitCode = missed || error.code === "VIEW_SECRET_REFUSED" ? 2 : 1;
    return;
  }
  if (argv.includes("--open")) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    try { execFileSync(command, [out], { stdio: "ignore" }); }
    catch {
      console.error(JSON.stringify({ code: "VIEW_OPEN_FAILED", path: out, message: "The snapshot was written; the OS opener failed." }));
      process.exitCode = 1;
      return;
    }
  }
  if (argv.includes("--json")) console.log(JSON.stringify({ path: out, generated_at: model.generated_at, head: model.head, snapshot: true, opened: argv.includes("--open"), ...(mapExecution ? { map_execution: mapExecution } : {}) }));
  else console.log(out);
}

// --- sessions ---------------------------------------------------------------
// VIEW-2a: the session ledger, from local files only (lib/session-ledger.mjs).
// It never imports the API client, so it cannot send a request.
async function cmdSessions(argv) {
  const { buildSessionLedger } = await import("../lib/session-ledger.mjs");
  const { renderSessionLedgerText } = await import("../lib/session-ledger-render.mjs");
  const { renderSessionsPageHtml } = await import("../lib/view.mjs");
  const { parseSince } = await import("../lib/receipt.mjs");
  const usage = `${CLI_NAME} sessions [--since 24h|7d|2026-10-01] [--stack <name>] [--json] [--out <file.html>]`;
  let since = null, stack = null, outFlag;
  const flags = new Set(["--json", "--allow-outside-project"]);
  for (let i = 1; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith("--") && argv[i].includes("=") ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)] : [argv[i], undefined];
    if (["--since", "--stack", "--out"].includes(flag)) {
      const value = inline ?? argv[i + 1];
      if (!value || value.startsWith("-")) die("SESSIONS_ARGUMENT_INVALID", `${flag} needs one value.`, usage);
      if (inline === undefined) i++;
      if (flag === "--since") {
        if (since !== null) die("SESSIONS_ARGUMENT_INVALID", "Provide --since once.", usage);
        since = parseSince(value);
        // A window silently widened to everything would misreport the range.
        if (since === null) die("SESSIONS_SINCE_INVALID", "--since must be a relative window (90m, 24h, 7d, 2w) or a date.", usage);
      } else if (flag === "--stack") {
        if (stack !== null || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) die("SESSIONS_ARGUMENT_INVALID", "--stack needs one stack name.", usage);
        stack = value;
      } else {
        if (outFlag !== undefined) die("MISSING_OUT_PATH", "--out needs one file path.", usage);
        outFlag = value;
      }
    } else if (!flags.has(argv[i])) die("UNKNOWN_FLAG", "Unrecognized sessions argument.", `${CLI_NAME} sessions --help`);
  }
  const root = repoRoot();
  const ledger = buildSessionLedger(root, { since, stack });
  if (outFlag !== undefined) {
    const allowOutside = argv.includes("--allow-outside-project");
    try {
      const out = resolveOutputPath(root, resolve(outFlag), { allowOutside, fileOnly: true });
      // Link only to anchors that really exist in the current local report.
      // A missing/stale/unsafe report leaves the basis inline, never a dead link.
      let viewHref = null, viewAnchors = [];
      try {
        const { LAYOUT } = await import('../lib/layout.mjs');
        const { openEvidenceRoot, readEvidenceBytes } = await import('../lib/note-evidence.mjs');
        const viewPath = join(root, LAYOUT.viewOutput), opened = openEvidenceRoot(dirname(viewPath));
        if (opened && viewPath !== out) {
          const html = readEvidenceBytes(opened, basename(viewPath), { maxBytes: 8 * 1024 * 1024 }).toString('utf8');
          viewAnchors = [...html.matchAll(/\bid="(operation-[a-f0-9]{64})"/g)].map(match => match[1]);
          viewHref = relative(dirname(out), viewPath).split(sep).join('/');
        }
      } catch { /* absence is named by the renderer */ }
      writeViewFile(root, out, renderSessionsPageHtml(ledger, { project: basename(root), viewHref, viewAnchors }), { allowOutside });
      if (!argv.includes("--json")) { console.log(out); return; }
    } catch (error) {
      const missed = error.code === "VIEW_WITHHOLDING_MISSED";
      console.error(JSON.stringify({ code: error.code ?? "SESSIONS_WRITE_FAILED",
        message: missed ? error.message : error.code === "VIEW_SECRET_REFUSED" ? "A secret-shaped value was found; nothing was written." : "Could not write the sessions page; nothing was written.",
        next: missed ? "Report this withholding bug with the section name; the page was not written." : "Choose a regular project-local output file." }));
      process.exitCode = missed || error.code === "VIEW_SECRET_REFUSED" ? 2 : 1;
      return;
    }
  }
  console.log(argv.includes("--json") ? JSON.stringify(ledger, null, 1) : renderSessionLedgerText(ledger));
}

// --- map reconcile ---------------------------------------------------------
// The estate's imported suites and the measured context are deliberately
// separate witnesses. This command joins identity only and renders one model.
async function cmdMapReconcile(argv) {
  const root = resolve(argv[2] && !argv[2].startsWith("-") ? argv[2] : process.cwd());
  const asJson = argv.includes("--json");
  const asGfm = argv.includes("--gfm") || argv.includes("--markdown");
  const wanted = flagValue(argv, "--suite");
  const names = wanted ? [wanted] : listSuites(root);
  const imported = [];
  for (const name of names) {
    try {
      const { suite } = loadSuite(root, name);
      imported.push(...suite.requests.map((r) => ({ method: r.method, path: r.path })));
    } catch (error) {
      die(error.code ?? "RECONCILE_SUITE_INVALID", error.message, "Repair or re-save the named suite, then re-run reconciliation.");
    }
  }
  const gateway = [];
  const declarationDir = join(root, "api-declarations");
  if (existsSync(declarationDir)) for (const file of readdirSync(declarationDir).filter((x) => x.endsWith(".json"))) {
    try { const declaration = JSON.parse(readFileSync(join(declarationDir, file), "utf8")); gateway.push(...(declaration.declared ?? [])); }
    catch { /* a malformed declaration is not allowed to break identity reconciliation */ }
  }
  let ctx = null;
  try { ctx = loadContext(root); } catch { /* no measured context: report an empty witness */ }
  const measured = Object.keys(ctx?.operations ?? {}).map((op) => ({ op }));
  let findings = [];
  const baseline = join(root, BASELINE_FILE);
  if (existsSync(baseline)) {
    try {
      const parsed = JSON.parse(readFileSync(baseline, "utf8"));
      findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
    } catch { /* audit's named reader owns baseline errors; reconciliation stays identity-only */ }
  }
  const model = reconciliationModel({ imported, measured, gateway, findings });
  if (asJson) console.log(JSON.stringify(model, null, 2));
  else console.log(asGfm ? renderReconciliationGfm(model) : renderReconciliationText(model));
}

// --- start / first-time setup ---------------------------------------------
async function cmdStart(argv) {
  const root = repoRoot();
  let contract, stackName;
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!["--json", "--dry-run", "--contract", "--stack"].includes(flag))
      die("START_ARGUMENT_INVALID", "Unknown setup argument.",
        flag === "--import" ? `Import collections with ${CLI_NAME} import <collection.json>, then run ${CLI_NAME} start.`
          : `Use ${CLI_NAME} start [--json] [--dry-run] [--contract <path>].`);
    if (seen.has(flag)) die("START_ARGUMENT_DUPLICATE", `${flag} may be supplied only once.`, `Use ${CLI_NAME} start --help.`);
    seen.add(flag);
    if (flag === '--stack') {
      stackName = argv[++i];
      if (!stackName || stackName.startsWith('--')) die('STACK_ARGUMENT_INVALID', '--stack needs a stack name.');
    }
    if (flag === "--contract") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        die("CONTRACT_PATH_REQUIRED", "--contract needs an OpenAPI file path.", `Use ${CLI_NAME} start --contract <path>.`);
      contract = resolve(root, value);
      if (!existsSync(contract) || !statSync(contract).isFile())
        die("CONTRACT_NOT_FOUND", `No OpenAPI file at ${contract}.`, "Choose an existing OpenAPI document; setup has not written any files.");
      let operations;
      try { operations = operationsFrom(readContract(contract).doc); }
      catch { die("CONTRACT_INVALID", "The selected OpenAPI document could not be parsed.", "Repair the document before running setup again; nothing was written."); }
      if (!operations.length)
        die("NO_OPERATIONS", "The selected contract declares no supported operations.", "Choose an OpenAPI document with operations; nothing was written.");
    }
  }
  const dryRun = seen.has("--dry-run");
  if (!dryRun && !currentStackScope() && !hasLegacyStack(root) && !stackCatalog(root).stacks.length) {
    const selected = contract ?? findContract(root);
    if (selected && !setupPathProblem(root, selected)) {
      // Setup's existing all-file preflight runs before creating the new
      // stack, so a foreign registration cannot leave a partial installation.
      const preview = await cmdConnect(['connect', '--dry-run'], { silent: true, selectedContract: selected });
      if (preview.setup.wiring.state !== 'blocked') {
        const created = firstStack(root, { name: stackName, contract: selected });
        const scopedArgs = argv.includes('--contract') ? argv.map((value, i) =>
          argv[i - 1] === '--contract' ? created.scope.config.contract : value)
          : [...argv, '--contract', created.scope.config.contract];
        return withStackScope(created.scope, () => cmdStart(scopedArgs));
      }
    }
  }
  if (currentStackScope() && !contract) contract = currentStackScope().config.contract;
  if (contract && !currentStackScope()) process.env.API_CONTRACT = contract;
  const connection = await cmdConnect(["connect", ...(dryRun ? ["--dry-run"] : [])], { silent: true, selectedContract: contract });
  const { setup } = connection;
  let inventory = { state: "not_run", summary: {} };
  if (!dryRun && setup.wiring.state !== "blocked") {
    try {
      inventory = { ...await buildMapModel(root, { execute: false }), state: "available" };
    } catch (error) {
      inventory = error?.code === "NO_API_FOUND"
        ? { state: "empty", summary: { services: 0, operations: 0, external: 0 },
          message: "No recognized API surface yet. Agent setup is configured." }
        : { state: "failed", summary: {}, error: { code: "STATIC_INVENTORY_FAILED",
          message: "The static API inventory could not be completed. Agent wiring is retained; inspect the source or contract before retrying." } };
    }
  }
  const status = inventory.state === "failed" ? "attention" : setup.status;
  const report = { v: 1, command: "start", status, project: root, version: packageVersion(),
    requests_executed: 0, setup, inventory, connection };
  if (seen.has("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    const lines = [`${CLI_NAME} start — ${root}`, ""];
    if (inventory.state === "available") {
      const summary = inventory.summary;
      lines.push(`Static API inventory: ${summary.services} services, ${summary.operations} operations, ${summary.external} external dependencies.`);
      for (const service of inventory.services.slice(0, 5)) lines.push(`  ${service.name}`);
      if (inventory.services.length > 5) lines.push(`  …and ${inventory.services.length - 5} more services.`);
      for (const omission of inventory.omissions ?? [])
        lines.push(`${terminalText(omission.code)}: ${terminalText(omission.file)} — ${terminalText(omission.message)}`);
    } else if (inventory.state === "empty") lines.push(inventory.message);
    else if (inventory.state === "failed") lines.push(inventory.error.message);
    for (const row of [...connection.mcp, ...connection.skills, ...connection.pointers])
      if (["conflict", "differs", "manual"].includes(row.action))
        lines.push(`${row.action}: ${row.file ?? row.path}. ${row.reason ?? row.fix ?? ""}`);
    if (connection.omitted.length)
      lines.push(`Portable commands need a repo-local installation. ${connection.command_resolution.portable.remedy}`);
    const docsRemedy = connection.skills.find((row) => row.documentation_omitted)?.documentation_remedy;
    if (docsRemedy) lines.push(docsRemedy);
    lines.push("", dryRun || setup.wiring.state === "blocked" ? "Planned files (nothing written):" : "Files touched:");
    for (const row of dryRun || setup.wiring.state === "blocked" ? connection.planned_files : connection.touched_files)
      lines.push(`  ${row.action}: ${terminalText(row.path)}`);
    lines.push("", renderSetupReceipt(setup));
    console.log(lines.join("\n"));
  }
  process.exitCode = status === "attention" ? 1 : 0;
  return report;
}

async function cmdMcp(argv) {
  if (argv[1] !== "inspect") {
    console.error(`usage: ${CLI_NAME} mcp inspect [command…|url] [--only <key>] [--dry-run] [--label <name>] [--json] [--summary <path>] [--execute <tool> --args <tool>=<json>] [--execute-unsafe]`);
    process.exit(1);
  }
  const root = repoRoot();
  let options, inspection;
  try {
    options = parseMcpInspectOptions(argv.slice(2));
    if (options.summary) options.summary = safeMcpSummaryPath(root, options.summary);
    if (options.registered) {
      const clean = value => { try { return safeMcpValue(value); } catch { return "[withheld]"; } };
      const report = { dry_run: options.dryRun, registrations: [] };
      for (const registration of discoverMcpRegistrations(root, { only: options.only })) {
        const row = { key: clean(registration.key), host: registration.host, file: registration.file };
        if (registration.code) Object.assign(row, { code: registration.code, reason: registration.reason });
        else if (options.dryRun) row.status = "would inspect";
        else {
          try {
            const found = await inspectMcp({ command: registration.command, args: registration.args, env: registration.env, cwd: registration.cwd, label: registration.key });
            row.record = storeMcpInspection(root, found, { returnRecord: true });
            row.status = "inspected";
            const failure = Object.entries(found.declared).find(([key]) => key.endsWith("_error"))?.[1];
            if (failure) { row.code = failure.code; row.reason = failure.message; }
          } catch (error) {
            row.code = /^MCP_[A-Z_]+$/.test(error.code ?? "") ? error.code : "MCP_INSPECT_FAILED";
            row.reason = row.code === "MCP_INSPECT_FAILED" ? "registered inspection or record storage failed" : clean(error.message);
          }
        }
        report.registrations.push(row);
      }
      const rendered = gfm => {
        const cell = gfm ? summaryCell : clean;
        const lines = [options.dryRun ? "MCP project registrations (dry run; no servers spawned)" : "MCP project registrations"];
        if (!report.registrations.length) lines.push("No project MCP registrations found.");
        for (const row of report.registrations) {
          lines.push(`${cell(row.key)} (${cell(row.file ?? row.host)}): ${row.code ? `${cell(row.code)} — ${cell(row.reason)}` : row.status}`);
          if (row.record) lines.push(renderMcpReport(row.record, { gfm }));
        }
        return `${lines.join("\n")}\n`;
      };
      if (options.summary) writeMcpSummary(root, options.summary, rendered(true));
      process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : rendered(false));
      if (!options.dryRun && report.registrations.some(row => row.code)) process.exitCode = 1;
      return;
    }
    inspection = await inspectMcp(options);
  }
  catch (error) {
    const malformed = Number.isInteger(error.malformed_frames) ? `; malformed_frames: ${error.malformed_frames}` : "";
    die(error.code ?? "MCP_INSPECT_FAILED", `${error.message}${malformed}`, "Review the named error and opt in to each intended tool explicitly.");
  }
  let record;
  try { record = storeMcpInspection(root, inspection, { returnRecord: true }); }
  catch (error) { die(error.code ?? "MCP_STORE_FAILED", error.message, "Review the inspection record and project write permissions."); }
  if (options.summary) {
    try { writeMcpSummary(root, options.summary, renderMcpReport(record, { gfm: true })); }
    catch (error) { die(error.code ?? "MCP_SUMMARY_WRITE_FAILED", "Could not write the MCP summary.", "Choose a writable, regular summary path."); }
  }
  process.stdout.write(options.json ? `${JSON.stringify(record)}\n` : renderMcpReport(record));
  if (Object.keys(record.declared ?? {}).some(key => key.endsWith("_error"))) process.exitCode = 1;
}

// --- audit --ci ------------------------------------------------------------
// CI has exactly one lever, the exit code, so only NEW findings may pull it.
// Accepted debt lives in the committed baseline; resolved findings are reported
// (the baseline wants re-cutting) but never fail the build — a red build for
// things getting BETTER teaches people to stop running the audit.

function auditFreshness(results) {
  const rows = [];
  for (const result of results) {
    if (!result.hasContext) continue;
    const ctx = loadContext(result.dir);
    if (!ctx?.operations) continue;
    const historyRoot = result.repoRoot ?? result.dir;
    // init stores contract/source paths relative to the service directory,
    // while git history is queried from the checkout root. Resolve each fact
    // in the coordinate system that wrote it, then rebase only the source path
    // for the repository-wide history query.
    const digest = liveContractDigest(result.dir, ctx);
    for (const [op, entry] of Object.entries(ctx.operations)) {
      const source = entry.source_file;
      const sourceFromRepo = source
        ? relative(historyRoot, isAbsolute(source) ? source : join(result.dir, source))
        : null;
      const gradedEntry = sourceFromRepo && sourceFromRepo !== source
        ? { ...entry, source_file: sourceFromRepo }
        : entry;
      const fresh = freshnessFor(gradedEntry, historyRoot, digest);
      const state = fresh.confidence === "unverified" ? "unverified"
        : fresh.confidence === "suspect" ? "suspect"
          : fresh.age?.stale ? "age-stale" : null;
      if (!state) continue;
      const why = [...fresh.reasons,
        ...(fresh.age?.stale ? [ageReason(fresh.age)] : [])].join("; ");
      rows.push({ op, state, why, where: result.name });
    }
  }
  return rows.sort((a, b) => a.where.localeCompare(b.where) || a.op.localeCompare(b.op));
}

function auditViewBasis(results) {
  const attempts = results.reduce((n, r) => n + (r.attempted ?? 0), 0);
  const responses = results.reduce((n, r) => n + (r.checked ?? 0), 0);
  const environments = [...new Set(results.filter(r => r.attempted > 0).map(r => r.environment ?? "unnamed"))];
  return `Audit: ${attempts} requests attempted, ${responses} responses recorded${environments.length ? `; environments ${environments.join(", ")}` : "; not measured"}`;
}

function retainAuditView(root, current, { basis = "Stored audit comparison", ...options } = {}) {
  try {
    const baseline = readBaselineFile(root);
    if (baseline) retainViewModel(root, "audit", { ...diffBaseline(current, baseline),
      baselineGeneratedAt: baseline.generated_at, ...options }, { basis });
  } catch (error) { console.error(JSON.stringify({ code: "VIEW_RECORD_NOT_SAVED", kind: "audit", reason: error.code ?? "VIEW_WRITE_FAILED" })); }
}

function ciReport(root, current, { asJson = false, reportOnly = false,
  summaryPath = null, freshness = [], noExecute = false,
  protectedSummaryPaths = [], requestTarget: target = null, requestTargets = null,
  selectedRequestTarget = null, mcp = null, allowMcpBaseline = false } = {}) {
  // A stranger's first CI run must never end in a stack trace: a baseline that
  // exists but will not parse dies with a name, the path, and the way out.
  let baseline;
  try { baseline = readBaselineFile(root); }
  catch (e) {
    if (e.code !== "BASELINE_CORRUPT") throw e;
    die("BASELINE_CORRUPT", `${BASELINE_FILE} is unreadable: ${e.message}`,
      `Re-run: ${CLI_NAME} audit --baseline — regenerate the accepted state and commit the file.`);
  }
  const baselineFile = !baseline && allowMcpBaseline && mcp?.registered ? mcp.baseline : BASELINE_FILE;
  if (!baseline && allowMcpBaseline && mcp?.registered) baseline = { findings: [] };
  if (!baseline)
    die("BASELINE_NOT_FOUND", `No ${BASELINE_FILE} under ${terminalText(root)}.`,
      `Run: ${CLI_NAME} audit --baseline — accept the current findings, commit the file, then --ci has something to judge against.`);
  assertCiSummaryTarget(root, summaryPath, protectedSummaryPaths);
  const http = diffBaseline(current, baseline);
  const { resolved, unchanged } = http;
  const added = [...http.added, ...(mcp?.drift ?? [])];
  process.exitCode = !reportOnly && added.length ? 1 : 0;

  if (summaryPath) {
    let section;
    try {
      section = renderCiSummary({ added, resolved, unchanged, freshness, reportOnly,
        baselineGeneratedAt: baseline.generated_at ?? null, noExecute, mcp });
      appendCiSummary(summaryPath, section);
    } catch (error) {
      const code = error?.code === "SUMMARY_SECRET_REFUSED"
        ? error.code : "SUMMARY_WRITE_FAILED";
      die(code, `Could not append the CI summary to ${summaryPath}: ${error.message}`,
        "Choose an existing writable parent directory and a regular summary file.");
    }
  }

  retainViewModel(root, "audit", { added, resolved, unchanged, freshness, reportOnly,
    baselineGeneratedAt: baseline.generated_at ?? null, noExecute, mcp }, {
    basis: noExecute ? "Static audit and stored freshness; no HTTP requests executed"
      : "Audit comparison; execution evidence is recorded per operation in the store",
  });

  if (asJson) {
    console.log(JSON.stringify({ root,
      ...(requestTargets ?? (target ? { request_target: target }
        : selectedRequestTarget ? { selected_request_target: selectedRequestTarget,
          request_execution: false } : {})),
      baseline_file: baselineFile,
      baseline_generated_at: baseline.generated_at ?? null,
      ...(reportOnly ? { report_only: true, would_fail: added.length } : {}),
      new: added, resolved, unchanged,
      ...(mcp?.registered ? { mcp } : {}) }, null, 2));
    return;
  }

  auditRow(`API audit (CI) — ${terminalText(root)}`);
  for (const row of requestTargets?.request_targets ?? (target ? [target] : []))
    auditRow(`  ${row.service ? `${row.service}: ` : ""}environment '${row.environment ?? "unnamed"}' — ${row.base_url}` +
      (row.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : ""));
  for (const row of requestTargets?.selected_request_targets
    ?? (requestTargets?.selected_request_target ? [requestTargets.selected_request_target] : []))
    auditRow(`  selected ${row.service ? `${row.service}: ` : ""}environment '${row.environment ?? "unnamed"}' — ` +
      `${row.base_url} (not executed)` +
      (row.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : ""));
  if (selectedRequestTarget)
    auditRow(`  selected environment '${selectedRequestTarget.environment ?? "unnamed"}' — ` +
      `${selectedRequestTarget.base_url} (not executed)` +
      (selectedRequestTarget.base_url_source === "API_BASE_URL" ? " (URL overridden by API_BASE_URL)" : ""));
  auditRow(`  baseline ${summaryCell(baselineFile)} (${baseline.generated_at ?? "undated"})  ` +
              `${unchanged} accepted finding${unchanged === 1 ? "" : "s"} unchanged`);
  console.log("");
  const row = (f) => f.kind?.startsWith("mcp-")
    ? `    ${summaryCell(f.service)}  ${summaryCell(f.op)}  ${summaryCell(f.kind)}  ${summaryCell(f.detail)}`
    : `    ${f.severity.padEnd(6)}  ${(f.service ?? "").padEnd(12)}  ${(f.op ?? "").padEnd(26)}  ${f.detail ?? ""}`;
  if (added.length) {
    console.log(`  NEW since the baseline (${added.length}) — ` +
      `${reportOnly ? "these WOULD fail an enforcing gate" : "these fail the build"}:\n`);
    for (const f of added) auditRow(row(f));
    auditRow("");
  }
  if (resolved.length) {
    console.log(`  resolved since the baseline (${resolved.length}) — re-cut it with audit --baseline:\n`);
    for (const f of resolved) auditRow(row(f));
    auditRow("");
  }
  if (!added.length && !resolved.length) console.log(mcp?.coverage_gaps.length
    ? "  no new comparable findings; MCP coverage gaps remain.\n"
    : "  no drift: current findings match the baseline exactly.\n");
  if (mcp?.registered) {
    auditRow(`  MCP declaration witness — ${summaryCell(mcp.baseline)}: ${mcp.checked}/${mcp.registered} registered servers compared; ${mcp.drift.length} declaration changes; enumeration only, no tools called.`);
    for (const gap of mcp.coverage_gaps)
      auditRow(`    coverage gap: ${summaryCell(gap.server)} (${summaryCell(gap.file)}) — ${summaryCell(gap.code)}: ${summaryCell(gap.reason)}`);
  }
  if (reportOnly)
    auditRow(`  report-only: found ${added.length} findings that WOULD fail an enforcing gate.`);
  else auditRow(added.length
    ? `  exit 1 — ${added.length} new finding${added.length === 1 ? "" : "s"}.`
    : "  exit 0 — nothing new.");
}

// --- show ------------------------------------------------------------------

// --- repos / grant / revoke -------------------------------------------------
//
// The machine registry, from the CLI. `grant <provider>` is said from the
// CONSUMER's seat — "let this repo read <provider>'s knowledge file" — because
// that is where the need is felt: an agent mid-task in the storefront repo
// wanting the billing repo's gotchas. `--to <repo>` grants for a different
// consumer. Direction is always printed as a sentence; a grant grid nobody
// can read aloud is how access sprawls.
//
// A damaged registry refuses MUTATION with the path in hand and never
// overwrites; reads elsewhere (show) degrade to local-only. Registration is
// inert — being listed grants nothing, in either direction.

function registryForWrite() {
  const { registry, problem } = loadRegistry();
  if (problem) die(problem.code, problem.message, problem.next);
  return registry;
}

// Resolve a grant/revoke reference to a registered repo id. A PATH that is not
// yet registered is registered on the spot when `registerMissing` — naming a
// directory on disk is intent enough — but a NAME must already exist, because
// inventing a repo from a typo would create a grant pointing at nothing.
function refToId(registry, ref, { registerMissing }) {
  const r = resolveRef(registry, ref);
  if (r?.id) return r.id;
  if (r?.ambiguous)
    die("REPO_AMBIGUOUS", `'${ref}' names ${r.ambiguous.length} repos: ${r.ambiguous.map((c) => c.root).join(", ")}.`,
      "Use the path (or the id from `repos --json`) instead of the name.");
  if (r?.unregistered && registerMissing && existsSync(r.path))
    return registerRepo(registry, r.path).id;
  if (r?.unregistered)
    die("REPO_NOT_FOUND", `${r.path} ${existsSync(r.path) ? "is not a registered repo" : "does not exist"}.`,
      `Run \`${CLI_NAME} repos\` to see what is registered.`);
  die("REPO_NOT_FOUND", `No registered repo named '${ref}'.`,
    `Run \`${CLI_NAME} repos\` to see what is registered, or pass a path to register one.`);
}

function grantArgs(argv) {
  const args = argv.slice(1);
  const at = args.indexOf("--to");
  const consumerRef = at !== -1 ? args[at + 1] : null;
  if (at !== -1) args.splice(at, 2);
  const providerRef = args.find((a) => !a.startsWith("--"));
  if (!providerRef) {
    console.error(`usage: ${CLI_NAME} ${argv[0]} <repo-name-or-path> [--to <consumer>]`);
    process.exit(1);
  }
  return { providerRef, consumerRef };
}

function cmdGrant(argv) {
  const { providerRef, consumerRef } = grantArgs(argv);
  const registry = registryForWrite();
  // The consumer defaults to the repo the command is said from, registered on
  // the spot — the grant IS the adoption act for a repo that never ran connect.
  const consumerId = consumerRef
    ? refToId(registry, consumerRef, { registerMissing: true })
    : registerRepo(registry, repoRoot()).id;
  const providerId = refToId(registry, providerRef, { registerMissing: true });
  if (consumerId === providerId)
    die("GRANT_SELF", "A repo always reads its own knowledge file; a self-grant means nothing.",
      "Name a different repo as the provider.");
  const { changed } = addGrant(registry, consumerId, providerId);
  saveRegistry(registry);
  const c = registry.repos[consumerId], p = registry.repos[providerId];
  console.log(changed
    ? `${c.name} may now read ${p.name}'s ${contextFile()} (${p.root}).`
    : `${c.name} could already read ${p.name}; nothing changed.`);
}

function cmdRevoke(argv) {
  const { providerRef, consumerRef } = grantArgs(argv);
  const registry = registryForWrite();
  const consumerId = consumerRef
    ? refToId(registry, consumerRef, { registerMissing: false })
    : registerRepo(registry, repoRoot()).id;
  const providerId = refToId(registry, providerRef, { registerMissing: false });
  const { changed } = dropGrant(registry, consumerId, providerId);
  saveRegistry(registry);
  const c = registry.repos[consumerId], p = registry.repos[providerId];
  console.log(changed
    ? `${c.name} may no longer read ${p.name}. Dead on the next query — nothing caches grants.`
    : `${c.name} had no grant on ${p.name}; nothing changed.`);
}

function cmdRepos(argv) {
  const { registry, path, problem } = loadRegistry();
  if (problem) die(problem.code, problem.message, problem.next);
  const repos = Object.entries(registry.repos).map(([id, r]) => ({
    id, name: r.name, root: r.root,
    present: existsSync(r.root),
    context: existsSync(join(r.root, contextFile(r.root))),
    registered_at: r.registered_at, last_seen_at: r.last_seen_at,
  }));
  const grants = registry.grants.map((g) => ({ ...g,
    consumer_name: registry.repos[g.consumer]?.name ?? g.consumer,
    provider_name: registry.repos[g.provider]?.name ?? g.provider,
  }));
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ file: path, repos, grants }, null, 1));
    return;
  }
  if (!repos.length) {
    console.log(`No repos registered. Run \`${CLI_NAME} connect\` in a repo, or grant one directly: ${CLI_NAME} grant <path>.`);
    return;
  }
  const out = [`registry — ${path}\n`];
  for (const r of repos)
    out.push(`  ${r.name.padEnd(24)} ${r.root}${r.present ? "" : "   (missing — root no longer exists)"}${r.context ? "" : r.present ? `   (no ${contextFile()})` : ""}`);
  out.push("", grants.length ? "  who may read whom:" : `  no grants — every repo is an island until \`${CLI_NAME} grant\` says otherwise.`);
  for (const g of grants) out.push(`    ${g.consumer_name} → may read → ${g.provider_name}`);
  console.log(out.join("\n"));
}

function noteProjection(entry, operation, options = {}) {
  const projection = projectKnownNotes(entry, { ...options, operation });
  for (const record of projection.history.records) Object.assign(record, decorateNoteRecord(record, { ...options, entry, history: projection.history }));
  return { active_notes: projection.notes, note_history: projection.history,
    note_projection: { meaning: NOTE_DATA_MEANING, records: projection.records,
      conflicts: noteCorrectionConflicts(entry, projection.history, { operation, stack: currentStackScope()?.stack }) } };
}
function printNoteReviewData(record) {
  console.log(`    ${terminalText(noteDataText(record))}`);
}
function printNoteConflicts(projection) {
  for (const conflict of projection?.conflicts ?? []) console.log(`  ${conflict.code}: ${terminalText(conflict.meaning)}\n    ${terminalText(conflict.retirement_path)}`);
}

function showObservationProjection(root, operation, { configRoot = root, environment, legacyConfidence, entry, ctx } = {}) {
  const config = resolveConfig(configRoot, environment ? { environment } : {});
  const file = findContract(configRoot, config);
  const observation_summary = showObservationSummary(root, operation, { config,
    contract: file ? loadHttpContract(file, { pathPrefix: config.contractPathPrefix }) : null });
  ctx ??= loadContext(configRoot);
  entry ??= ctx?.operations?.[operation] ?? {};
  const freshness = freshnessFor(entry, configRoot, liveContractDigest(configRoot, ctx), Date.now(), { commits: false });
  const options = { summary: observation_summary, freshness, staleDays: config.defaults?.staleDays ?? 180,
    ...loadNoteReadContext(configRoot, ctx, { config }).forOperation(operation) };
  return { evidence_class: evidenceClass({ entry, ...options }), ...noteProjection(entry, operation, options),
    ...(legacyConfidence ? { confidence: observationConfidence(legacyConfidence, observation_summary),
    legacy_confidence: legacyConfidence } : observationConfidence(null, observation_summary) === 'observed'
      ? { confidence: 'observed' } : {}), observation_summary };
}

function stackFactDetail(ctx, { evidence, operation } = {}) {
  if (!ctx || ctx.stack_facts === undefined) return undefined;
  const projection = noteProjection(ctx.stack_facts, "stack");
  const classes = { written: 0, observed: 1, asserted: 2, verified: 3 };
  const records = new Map(projection.note_projection.records.map(record => [record.id,
    { best: record, operations: [], kinds: new Set() }]));
  for (const row of evidence?.operations.values() ?? []) {
    if (operation && row.operation !== operation) continue;
    const candidates = rankNoteRecords(projection.note_history.active,
      { history: projection.note_history, summary: row.summary, freshness: row.freshness });
    for (const candidate of candidates) {
      if (Object.hasOwn(candidate.provenance ?? {}, "operations") && (!validNoteOperations(candidate.provenance.operations) || !candidate.provenance.operations.includes(row.operation))) continue;
      const record = records.get(candidate.id);
      if (classes[candidate.evidence_class.class] > classes[record.best.evidence_class.class]) record.best = candidate;
      if (candidate.contradictions.length) {
        record.operations.push(row.operation);
        for (const kind of candidate.contradictions) record.kinds.add(kind);
      }
    }
  }
  projection.note_projection.records = [...records.values()].map(record => ({ ...record.best,
    contradictions: [...record.kinds], contradicted_operations: record.operations }));
  return { key: { kind: "stack" }, ...projection };
}
function printStackFacts(facts, argv) {
  if (!facts) return;
  console.log("Stack facts (authored guidance):");
  for (const note of facts.note_projection?.records ?? facts.note_history.active) {
    printNoteReviewData(note);
    const operations = note.provenance?.operations;
    const scope = operations === undefined ? "every operation" : validNoteOperations(operations) ? operations.map(terminalText).join(", ") : "invalid scope; review history";
    console.log(`  ${terminalText(note.text)}\n    ${note.id}; ${terminalText(note.provenance?.by ?? "unknown author")}; ${terminalText(note.provenance?.at ?? "unknown date")}; applies to: ${scope}${note.contradictions?.length ? `; conflicts with latest observation (${note.contradictions.join(", ")}) on ${note.contradicted_operations.map(terminalText).join(", ")}` : ""}`);
  }
  for (const issue of facts.note_history.issues) console.log(`  ${issue.code}: ${issue.message}`);
  if (argv.includes("--history")) for (const note of facts.note_history.history) console.log(`  Superseded: ${terminalText(note.text)}; ${note.id}`);
  if (facts.note_history.state === "invalid") process.exitCode = 1;
}

function printCodeLocations(code) {
  if (!code) return;
  console.log("Code locations (declared by code; not execution evidence):");
  for (const key of ['defined_in', 'called_from']) for (const location of code[key] ?? []) {
    const state = location.state === 'not-found' ? '; not found at the working tree'
      : location.state === 'remembered' ? '; remembered source location' : '';
    console.log(`  ${key}: ${terminalText(location.file)}${location.line ? `:${location.line}` : ''}${state}`);
  }
}
async function printOperationDetail(detail, argv) {
  if (!detail.from && /^[A-Z]+ \//u.test(detail.op ?? '')) {
    detail = { ...detail, code: forOperationCode(repoRoot(), currentStackScope()?.stack, detail.op) };
    const { querySurvey } = await import('../lib/survey.mjs');
    detail.survey = querySurvey(repoRoot(), { stack: currentStackScope()?.stack ?? 'legacy', operation: detail.op });
    if (typeof detail.source_file === 'string' && codePathWithheld(repoRoot(), detail.source_file)) {
      const source = detail.source_file;
      detail.source_file = 'withheld';
      detail.why = detail.why?.map(reason => String(reason).split(source).join('withheld'));
    }
  }
  const history = detail.note_history;
  if (argv.includes("--human")) {
    printStackFacts(detail.stack_facts, argv);
    printCodeLocations(detail.code);
    if (detail.survey) console.log(detail.survey.state === 'ready'
      ? `Survey snapshot: ${detail.survey.snapshot.id}; built ${detail.survey.snapshot.built_at}; ${detail.survey.current_inputs?.checked_at
        ? `last explicit input check ${detail.survey.current_inputs.checked_at} (${detail.survey.current_inputs.state})`
        : 'current inputs not checked'}. ${detail.survey.relationships.length} relationship(s); ${detail.survey.omitted.relationships} omitted. Use ${CLI_NAME} survey query --operation "${terminalText(detail.op)}" for provenance.`
      : `Survey: ${detail.survey.state}. ${detail.survey.command ?? `${CLI_NAME} survey generate`}`);
    console.log(`${detail.op} — ${detail.evidence_class?.class ?? detail.confidence ?? "unverified"}`);
    if (detail.evidence_class) console.log(`Evidence class: ${detail.evidence_class.reason}; latest eligible response successful: ${detail.evidence_class.current_success}.`);
    if (detail.legacy_confidence) console.log(`Legacy execution verification: ${detail.legacy_confidence}; verified_at: ${detail.verified_at ?? "none"}.`);
    if (detail.observation_summary) {
      const summary = detail.observation_summary;
      console.log(`Recorded client observations: ${summary.state}${summary.unavailable_reason ? ` (${summary.unavailable_reason})` : ""}; ${summary.observation_count} retained response(s); statuses: ${summary.observed_status_codes.join(", ") || "none"}; observed_at: ${summary.observed_at ?? "none"}.`);
      if (summary.latest_recorded_observed_at) console.log(`  Newest recorded time: ${summary.latest_recorded_observed_at}; statuses: ${summary.latest_recorded_status_codes.join(", ") || "unavailable"}; ${summary.latest_tied_observations} response(s); all newest responses eligible and successful: ${summary.latest_response_eligible}.`);
      if (summary.scope) console.log(`  Scope: ${summary.scope.provider}; ${summary.scope.environment}; ${summary.scope.operation}; contract: ${summary.scope.contractDigest}.`);
      for (const observation of summary.observations) console.log(`  ${observation.observation_id}: ${observation.observed_at}; HTTP ${observation.response_status}; assertions: ${observation.assertions ? `${observation.assertions.passed} passed, ${observation.assertions.failed} failed` : "not asserted"}; evidence: ${observation.evidence.map(ref => `${ref.path} (${ref.state})`).join(", ")}.`);
      for (const [reason, count] of Object.entries(summary.excluded)) console.log(`  Excluded ${count}: ${reason}.`);
      for (const [reason, count] of Object.entries(summary.omissions)) if (count) console.log(`  Omitted ${count}: ${reason}.`);
      for (const issue of summary.issues) console.log(`  Unavailable: ${issue.repository ?? "context"}; ${issue.code}.`);
      if (summary.scope_reason) console.log(`  Scope unresolved: ${summary.scope_reason}.`);
      for (const item of summary.skipped ?? [])
        console.log(`  Skipped: granted provider ${item.name ?? "unnamed"} (${item.repository}): directory missing; its history is not included.`);
      console.log(`  ${summary.meaning}`);
    }
    if (history) {
      console.log(`Note history: ${history.state}; ${history.digest}`);
      for (const issue of history.issues) console.log(`  ${issue.severity}: ${issue.code} — ${issue.message}`);
      console.log("Active guidance:");
      for (const record of detail.note_projection?.records ?? history.active) console.log(`  ${record.id}\n    ${terminalText(record.text)}\n    ${record.provenance?.by ?? "unknown author"}; ${record.provenance?.at ?? "unknown date"}; ${record.evidence_class?.class ?? 'written'}${record.contradictions?.length ? `; conflicts with latest observation: ${record.contradictions.join(', ')}` : ''}${`\n    ${terminalText(noteDataText(record))}`}`);
      printNoteConflicts(detail.note_projection);
      for (const record of history.active) for (const reference of record.provenance?.evidence ?? [])
        console.log(`    Evidence ${reference.run_id}: attachment-time state ${reference.state}; current receipt availability not checked; ${reference.provenance?.initiator ?? "unknown"}; ${reference.provenance?.transport ?? "unknown"}; ${reference.provenance?.observed_at ?? "unknown time"}${reference.scope?.operation ? `; ${reference.scope.operation}` : ""}. This link does not verify the explanation.`);
      if (!history.active.length) console.log("  No active notes.");
      if (argv.includes("--history")) {
        console.log("Superseded history (retained claims):");
        for (const record of history.history) console.log(`  ${record.id}\n    ${record.text}\n    ${record.provenance?.by ?? "unknown author"}; ${record.provenance?.at ?? "unknown date"}\n    ${JSON.stringify(record.superseded)}`);
        if (!history.history.length) console.log("  No superseded notes.");
      } else if (history.history.length) console.log(`  ${history.history.length} superseded note(s); use --history to read them.`);
    }
    if (detail.scoped) {
      console.log(`All-scope history: ${detail.scoped.operations?.length ?? 0} identity record(s); provider/environment/contract applicability is separate. Use JSON output to inspect them.`);
      for (const issue of detail.scoped.issues ?? []) console.log(`  Unavailable history: ${issue.repository ?? "context"}; ${issue.code}.`);
      for (const item of detail.scoped.skipped ?? [])
        console.log(`  Skipped history: granted provider ${item.name ?? "unnamed"} (${item.repository}): directory missing.`);
      for (const [reason, count] of Object.entries(detail.scoped.omissions ?? {})) if (count) console.log(`  Omitted history ${count}: ${reason}.`);
      if (detail.scoped.key_sources_omitted)
        console.log(`  Key-source lists beyond the read bound: ${detail.scoped.key_sources_omitted} record(s) returned without key_sources; their links are not shown.`);
    }
  } else console.log(JSON.stringify(detail, null, 1));
  if (history?.state === "invalid") process.exitCode = 1;
}

function showAccountFacts(argv) {
  const scope = currentStackScope();
  if (!scope) die("STACK_REQUIRED", "Choose a stack for account facts with --stack <name>.");
  let selectedScope, environment;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (["--human", "--history", "--json"].includes(arg)) continue;
    if (arg === "--scope" || arg === "--env" || arg.startsWith("--env=")) {
      const value = arg.startsWith("--env=") ? arg.slice(6) : argv[++index];
      if (!value || value.startsWith("--")) die("SHOW_OPTION_INVALID", `${arg} needs a value.`);
      if (arg === "--scope") {
        if (selectedScope !== undefined || value !== "account") die("SHOW_OPTION_INVALID", "Use --scope account once.");
        selectedScope = value;
      } else {
        if (environment !== undefined || value !== scope.config.name) die("SHOW_OPTION_INVALID", "Provide --env once with the selected environment name.");
        environment = value;
      }
    } else die("SHOW_OPTION_INVALID", "Account facts use --scope account, --env, --human, --history or --json; they do not take an operation.");
  }
  const projection = readAccountFacts(repoRoot(), { scope, history: argv.includes("--history"), maxFacts: 100 });
  const report = { stack: scope.stack, environment: scope.config.name, scope: "account", ...projection };
  if (argv.includes("--human")) {
    console.log(`Account facts: ${terminalText(scope.stack)} / ${terminalText(scope.config.name)}. Authored account guidance, not API-wide truth.`);
    for (const fact of projection.records) {
      const state = fact.credential_state === "changed" ? "credential changed since observed"
        : fact.credential_state === "unconfirmed" ? "not confirmed for this machine's credential"
          : fact.credential_state === "missing" ? "credential unavailable; cannot confirm applicability" : "credential unchanged since confirmation";
      console.log(`  ${terminalText(fact.text)}\n    ${terminalText(fact.id)}; ${terminalText(fact.at ?? "unknown date")}; ${fact.shared ? "shared" : "private"}; ${terminalText(fact.credential_reference)}; ${state}${fact.superseded ? "; superseded" : ""}`);
      for (const evidence of fact.evidence ?? []) console.log(`    Evidence ${terminalText(evidence.run_id)}: attachment-time state ${terminalText(evidence.state)}; current receipt availability not checked. This link does not verify the explanation.`);
    }
    if (!projection.records.length) console.log("  No applicable account facts.");
    if (projection.omitted) console.log(`Omitted ${projection.omitted} account fact(s). ${terminalText(projection.show_command)}`);
    for (const issue of projection.issues ?? []) console.log(`  ${terminalText(issue.code ?? issue)}: account history or confirmation needs attention.`);
  } else console.log(JSON.stringify(report, null, 1));
  if (projection.issues?.length) process.exitCode = 1;
}

async function cmdShow(argv) {
  if (argv.includes("--scope")) return showAccountFacts(argv);
  const root = repoRoot();
  try {
    const stat = statSync(join(root, contextFile()));
    if (!stat.isFile()) die("CONTEXT_INVALID", "The knowledge path is not a regular file.", "Restore the local knowledge file before inspecting its history.");
    if (stat.size > MAX_CONTEXT_BYTES) die("CONTEXT_TOO_LARGE", "The knowledge file exceeds its 16 MiB read limit.", "Reduce the file before inspecting its history; no API request is needed.");
  } catch (error) {
    if (error.code !== "ENOENT") die("CONTEXT_UNAVAILABLE", "The knowledge file could not be inspected.", "Check its local filesystem permissions; no API request is needed.");
  }
  const loaded = loadContext(root);
  const ctx = loaded?.v === 0 && loaded.operations && typeof loaded.operations === "object"
    && !Array.isArray(loaded.operations) ? loaded : null;
  const showArgs = [];
  let environment;
  for (let index = 1; index < argv.length; index++) {
    if (["--human", "--history", "--json"].includes(argv[index])) continue;
    if (argv[index] === "--env" || argv[index].startsWith("--env=")) {
      const value = argv[index].startsWith("--env=") ? argv[index].slice(6) : argv[index + 1];
      if (environment !== undefined || !value || value.startsWith("--"))
        die("SHOW_OPTION_INVALID", "Provide --env once with an environment name.");
      environment = value;
      if (argv[index] === "--env") index++;
      continue;
    }
    showArgs.push(argv[index]);
  }
  if (showArgs.some(value => value.startsWith("--"))) die("SHOW_OPTION_INVALID", "Unknown show option.", "Use --human, --history, --json or --env <name>.");
  const wanted = showArgs.join(" ");
  if (!wanted && currentStackScope()) {
    // The exact recovery command in capped stack sections is useful without
    // knowing an omitted operation's name. Reuse the map projection so its
    // inventory and observation counts cannot invent a second grading rule.
    const map = buildApiMapModel(root, { environment, learnedReasons: false });
    const scoped = queryOperationContext(root, { stack: currentStackScope().stack }, { maxItems: 100, maxBytes: 1024 * 1024 });
    const evidence = stackEvidenceClasses(root, ctx ?? {}, { config: resolveConfig(root, environment ? { environment } : {}) });
    const noteRead = loadNoteReadContext(root, ctx);
    const operations = (map.operations ?? []).map(row => {
      const grade = evidence.operations.get(row.op);
      return { ...row, ...(row.op && ctx?.operations?.[row.op]
        ? noteProjection(ctx.operations[row.op], row.op, { summary: grade?.summary, freshness: grade?.freshness, ...noteRead.forOperation(row.op) }) : { active_notes: [] }) };
    });
    const report = { stack: currentStackScope().stack, ...(ctx?.stack_facts !== undefined ? { stack_facts: stackFactDetail(ctx, { evidence }) } : {}), environment: currentStackScope().config.name,
      meaning: "Saved stack inventory and authored guidance. Observations remain separate from legacy execution verification.",
      counts: { ...(ctx?.stack_facts !== undefined ? { stack_facts: inspectNoteHistory(ctx.stack_facts).active.length } : {}), operations: map.counts?.operations ?? 0, evidence_classes: map.counts?.evidence_classes, observed: map.counts?.observed_total ?? 0,
        responses: map.observations?.counted ?? 0, notes: map.counts?.notes ?? 0 },
      lanes: reviewLaneSummary(operations.flatMap(row => row.note_projection?.records ?? [])),
      authors: reviewAuthorSummary(operations.flatMap(row => row.note_projection?.records ?? [])),
      operations, scoped, omissions: map.omissions ?? {}, withheld: map.withheld ?? {} };
    if (argv.includes("--human")) {
      console.log(`Stack ${report.stack}: ${report.counts.operations} operations; ${formatEvidenceClassCounts(report.counts.evidence_classes)}; ${report.counts.responses} retained responses; ${report.counts.notes} authored notes.`);
      console.log(report.meaning);
      console.log(`Note authors: ${report.authors.map(row => `${row.count} ${row.category}`).join(', ')}.`);
      printStackFacts(report.stack_facts, argv);
      for (const row of operations) {
        console.log(`\n${terminalText(row.op ?? "[operation withheld]")} — ${terminalText(row.standing?.label ?? "unverified")}`);
        for (const note of row.note_projection?.records ?? row.active_notes.map(text => ({ text }))) {
          console.log(`  ${terminalText(note.text)}${note.contradictions?.length ? ` — conflicts with latest observation: ${note.contradictions.join(', ')}` : ''}`);
          printNoteReviewData(note);
        }
        printNoteConflicts(row.note_projection);
        printCodeLocations(row.code);
        if (argv.includes("--history")) for (const note of row.note_history?.history ?? []) console.log(`  Superseded: ${terminalText(note.text)}`);
      }
      for (const record of scoped.operations) for (const observation of record.observations)
        if (observation.basis === "authored") for (const note of observation.notes ?? [])
          console.log(`\n${terminalText(record.identity.operation)} — inherited authored guidance (${terminalText(record.identity.environment)}): ${terminalText(note)}`);
      for (const [kind, count] of Object.entries(scoped.omissions)) if (count) console.log(`Omitted ${kind}: ${count}. Inspect an exact operation with show --stack ${report.stack} "<METHOD /path>".`);
      for (const issue of scoped.issues) console.log(`Unavailable history: ${terminalText(issue.code)}.`);
    } else console.log(JSON.stringify(report, null, 1));
    if (report.stack_facts?.note_history.state === "invalid" || scoped.issues.length || operations.some(row => row.note_history?.state === "invalid")) process.exitCode = 1;
    return;
  }
  if (!wanted) die("OPERATION_REQUIRED", "Name an operation to inspect.", `${CLI_NAME} show "GET /path"`);
  const inspected = inspectedToolFor(ctx, wanted);
  if (inspected?.code === "MCP_TOOL_AMBIGUOUS") die(inspected.code,
    `Tool '${wanted}' is declared by multiple servers: ${inspected.servers.join(", ")}.`,
    `Qualify the tool with its registration label: ${CLI_NAME} show "<label>/<tool>"`);
  if (inspected) { console.log(JSON.stringify(inspected, null, 1)); return; }
  const keys = ctx ? Object.keys(ctx.operations) : [];
  const key = keys.find((k) => k.toLowerCase() === wanted.toLowerCase())
    ?? keys.find((k) => k.toLowerCase().includes(wanted.toLowerCase()));
  const fromTests = inspectImportedTestClaims(root, key ?? wanted, {
    bindings: importedClaimBindings(resolveConfig(root, environment ? { environment } : {})) });
  if (!key) {
    if (fromTests.claims.length) {
      const scoped = queryOperationContext(root, { protocol: "http", operation: wanted });
      await printOperationDetail({ op: wanted, legacy: null,
        ...showObservationProjection(root, wanted, { environment }), from_tests: fromTests, scoped }, argv);
      process.exitCode = scoped.issues.length ? 1 : 0;
      return;
    }
    // Not known locally — a GRANTED provider may know it. The registry is read
    // fresh here, at query time: a revoked grant is already dead, a provider's
    // new learning is already visible. Default deny means no grant and no
    // registry read identically: the operation does not exist from this seat.
    // The answer that does come back is labelled with WHERE it came from —
    // freshness computed against the provider's repo, not this one, because
    // that is the git history the entry's confidence is derived from.
    const hit = crossLookup(root, wanted);
    if (hit) {
      const { confidence, reasons, age } =
        freshnessFor(hit.entry, hit.provider.root, liveContractDigest(hit.provider.root, hit.ctx));
      const ageLine = ageReason(age);
      await printOperationDetail({
        op: hit.key,
        from: { repo: hit.provider.name, root: hit.provider.root },
        why: age?.stale ? [...reasons, `BUT ${ageLine}`] : reasons,
        ...(age ? { age } : {}),
        ...hit.entry,
        ...showObservationProjection(root, hit.key, { configRoot: hit.provider.root, environment, legacyConfidence: confidence, entry: hit.entry, ctx: hit.ctx }),
        // Query from the consumer so only its current grants apply. A provider
        // may itself have grants that this consumer is not allowed to inherit.
        scoped: queryOperationContext(root, { protocol: "http", operation: hit.key }),
      }, argv);
      return;
    }
    // Automatic capture can exist without a legacy operation entry. Exact
    // scoped inspection still works; it must not invent legacy verification.
    if (wanted) {
      const scoped = queryOperationContext(root, { protocol: "http", operation: wanted });
      if (scoped.operations.length || scoped.issues.length || Object.values(scoped.omissions).some(Boolean) || fromTests.claims.length) {
        const unavailable = !scoped.operations.length && scoped.issues.length;
        await printOperationDetail({ op: wanted, legacy: null,
          ...showObservationProjection(root, wanted, { environment }),
          ...(unavailable ? { error: {
            code: scoped.issues.some(issue => issue.repository === "local") ? "CONTEXT_UNAVAILABLE" : "OPERATION_NOT_FOUND",
            message: "No readable matching observation was returned. Inspect scoped.issues for unavailable sources.",
          } } : {}), scoped, ...(fromTests.claims.length ? { from_tests: fromTests } : {}) }, argv);
        process.exitCode = scoped.issues.length ? 1 : 0;
        return;
      }
    }
    // Contract-only operations can have a real source declaration before an
    // observation or authored note exists. Show that navigation without
    // inventing a knowledge record or an execution claim.
    if (currentStackScope()?.stack) {
      const code = forOperationCode(root, currentStackScope().stack, wanted);
      if (code.defined_in.length || code.called_from.length) {
        await printOperationDetail({ op: wanted, legacy: null,
          ...showObservationProjection(root, wanted, { environment }), code }, argv);
        return;
      }
    }
    if (!ctx) die("NO_CONTEXT", `No ${contextFile()} in ${root}.`, initHint(root));
    die("OPERATION_NOT_FOUND", `No operation matching '${wanted}'.`,
      `Choose an exact operation from ${contextFile()}, then run: ${CLI_NAME} show "<METHOD /path>"`);
  }
  const { confidence, reasons, age } = freshnessFor(ctx.operations[key], root, liveContractDigest(root, ctx));
  // Age is surfaced as its own field, and its clause appended to `why`, so the
  // second staleness axis is legible without conflating it with source drift.
  // legacy_confidence preserves that grade; observed is a weaker, separate
  // presentation state backed by selected scoped responses.
  const ageLine = ageReason(age);
  await printOperationDetail({
    ...(ctx?.stack_facts !== undefined ? { stack_facts: stackFactDetail(ctx, { evidence: stackEvidenceClasses(root, ctx, { config: resolveConfig(root, environment ? { environment } : {}) }), operation: key }) } : {}), op: key,
    why: age?.stale ? [...reasons, `BUT ${ageLine}`] : reasons,
    ...(age ? { age } : {}),
    ...ctx.operations[key],
    ...showObservationProjection(root, key, { environment, legacyConfidence: confidence, entry: ctx.operations[key], ctx }),
    // Legacy verification and scoped client observations are separate records.
    // Show both without copying a response into a stronger legacy claim.
    scoped: queryOperationContext(root, { protocol: "http", operation: key }),
    ...(fromTests.claims.length ? { from_tests: fromTests } : {}),
  }, argv);
}

// --- note ------------------------------------------------------------------
//
// The declared half of API knowledge: the part no amount of probing derives.
// The client detects that something was learned; this is where the agent writes
// down what.
//
// This is also a new way for a secret to reach a committed file. Everything else
// that writes to sannr.json passes the promotion boundary, which only lets
// through values the contract already declared. Free text bypasses that entirely,
// so it gets its own guard.

// The credential shapes live in lib/verdicts.mjs now: `verdict` opened a
// second free-text door into the committed file, and two lists drift. Both
// commands import the SAME test, deliberately broad — a false refusal costs a
// rephrase, a false accept is permanent and in every clone.

function noteArguments(argv) {
  argv = argv.filter(value => value !== "--json");
  const words = [], evidence = [], operations = [];
  let supersedes, retires, reason, by, actor, basis, source, alongside = false, scope = "operation", scoped = false, shared = false, environment;
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--shared") {
      if (shared) noteArgumentError("NOTE_OPTION_INVALID", "Provide --shared once.");
      shared = true;
    } else if (value === "--env" || value.startsWith("--env=")) {
      const argument = value.startsWith("--env=") ? value.slice(6) : argv[++index];
      if (environment !== undefined || !argument || argument.startsWith("--") || argument !== currentStackScope()?.config.name)
        noteArgumentError("NOTE_OPTION_INVALID", "Provide --env once with the selected stack's environment.");
      environment = argument;
    } else if (value === "--alongside") {
      if (alongside) noteArgumentError("NOTE_OPTION_INVALID", "Provide --alongside once.");
      alongside = true;
    } else if (["--retires", "--reason", "--by", "--actor"].includes(value)) {
      const argument = argv[++index];
      if (!argument || argument.startsWith('--')) noteRefusal(noteReviewFailure(reviewError(value === '--retires' ? 'NOTE_DIGEST_REQUIRED' : value === '--reason' ? 'NOTE_RETIRE_REASON_REQUIRED' : value === '--by' ? 'NOTE_REVIEW_BY_REQUIRED' : 'NOTE_REVIEW_ACTOR_REQUIRED')));
      if (value === '--retires') { if (retires !== undefined) noteRefusal(noteReviewFailure(reviewError('NOTE_RETIRE_INVALID'))); retires = argument; }
      if (value === '--reason') { if (reason !== undefined) noteRefusal(noteReviewFailure(reviewError('NOTE_RETIRE_INVALID'))); reason = argument; }
      if (value === '--by') { if (by !== undefined) noteRefusal(noteReviewFailure(reviewError('NOTE_REVIEW_BY_REQUIRED'))); by = argument; }
      if (value === '--actor') { if (actor !== undefined) noteRefusal(noteReviewFailure(reviewError('NOTE_REVIEW_ACTOR_REQUIRED'))); actor = argument; }
    } else if (value === '--basis' || value === '--source') {
      const argument = argv[++index];
      if (!argument || argument.startsWith('--') || (value === '--basis' ? basis : source) !== undefined)
        noteArgumentError('NOTE_OPTION_INVALID', `${value} needs one value and may appear once.`);
      if (value === '--basis') basis = argument; else source = argument;
    } else if (["--supersedes", "--evidence", "--scope", "--operations"].includes(value)) {
      const argument = argv[++index];
      if (!argument || argument.startsWith("--")) noteArgumentError("NOTE_OPTION_INVALID", `${value} needs a value.`);
      if (value === "--evidence") evidence.push(argument);
      else if (value === "--scope") {
        if (scoped || !["operation", "stack", "account"].includes(argument)) noteArgumentError("NOTE_OPTION_INVALID", "Provide --scope operation, stack or account once.");
        scope = argument; scoped = true;
      } else if (value === "--operations") {
        operations.push(argument);
        while (argv[index + 1] && !argv[index + 1].startsWith("--")) operations.push(argv[++index]);
      } else {
        if (supersedes) noteArgumentError("NOTE_OPTION_INVALID", "Provide --supersedes once.");
        supersedes = argument;
      }
    } else if (value.startsWith("--")) noteArgumentError("NOTE_OPTION_INVALID", "Unknown note option.", "Use --scope stack or account, --operations, --shared, --supersedes, --alongside, --evidence or --json.");
    else words.push(value);
  }
  if (supersedes && alongside) noteArgumentError("NOTE_OPTION_INVALID", "Choose --supersedes or --alongside, not both.");
  if (retires !== undefined && (supersedes || alongside || scope !== 'operation') || reason !== undefined && retires === undefined)
    noteRefusal(noteReviewFailure(reviewError('NOTE_RETIRE_INVALID')));
  if (operations.length && scope !== "stack") noteArgumentError("NOTE_OPTION_INVALID", "--operations requires --scope stack.");
  if (shared && scope !== "account") noteArgumentError("NOTE_OPTION_INVALID", "--shared requires --scope account.");
  const op = scope === "operation" ? words.shift() : undefined;
  return { op, scope, operations, shared, text: words.join(" ").trim(), evidence, retires, reason, by, actor, basis, source,
    relation: supersedes ? { supersedes } : alongside ? { alongside: true } : undefined };
}

function noteRefusal(payload, exitCode = 3) {
  const output = process.argv.includes("--json") ? console.log : console.error;
  output(JSON.stringify(payload, null, 1));
  process.exit(exitCode);
}

function noteArgumentError(code, message, next) {
  noteRefusal({ error: { code, message, ...(next ? { next } : {}) } }, 1);
}

function noteWriteError(error, scope) {
  if (!/^(?:NOTE_|CONTEXT_)/.test(error?.code ?? "")) throw error;
  const stackRecovery = scope === "stack" ? `${CLI_NAME} show --stack ${currentStackScope().stack} --human --history; then review --stack ${currentStackScope().stack} --scope stack --accept-notes --if-notes <digest>` : null;
  const next = error.code === "NOTE_RELATION_REQUIRED"
    ? `Inspect the existing claims, then use --supersedes <full-note-digest> or --alongside.`
    : ["NOTE_BASELINE_REQUIRED", "NOTE_HISTORY_CHANGED"].includes(error.code)
      ? stackRecovery ?? `Review the complete history with ${CLI_NAME} show "${error.operation ?? "<operation>"}" --human --history; then explicitly accept its current digest with review --accept-notes "<operation>" --if-notes <digest>.`
      : `Re-read the named history and resolve the reported issue; no note was removed.`;
  noteRefusal({ refused: error.code, reason: error.message,
    ...(error.operation ? { operation: error.operation } : {}),
    ...(error.digest ? { digest: error.digest } : {}),
    ...(error.existing ? { existing: error.existing } : {}), next });
}

// Accepting a draft goes through precisely the ordinary authored-note path.
// The server's prose is never a command: only a bounded local, evidence-bound
// generated suggestion supplies the operation, scope and evidence references.
function draftNoteArguments(root, argv) {
  if (!argv.includes("--accept-draft")) return { argv, draft: null };
  const words = [], relation = [];
  let id;
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--json") continue;
    // The outer dispatcher has already bound this selector to the stack.
    // Preserve that resolved scope, but do not treat its spelling as note text.
    if (value === "--env" || value.startsWith("--env=")) {
      const selected = value === "--env" ? argv[++i] : value.slice(6);
      if (!selected || selected !== currentStackScope()?.config.name)
        noteArgumentError("NOTE_OPTION_INVALID", "The draft environment must match the selected stack scope.");
      continue;
    }
    if (value === "--accept-draft" || value === "--supersedes") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) noteArgumentError("NOTE_OPTION_INVALID", `${value} needs a value.`);
      if (value === "--accept-draft") {
        if (id) noteArgumentError("NOTE_OPTION_INVALID", "Provide --accept-draft once.");
        id = next;
      } else relation.push(value, next);
    } else if (value === "--alongside") relation.push(value);
    else if (value.startsWith("--")) noteArgumentError("NOTE_OPTION_INVALID", "Draft acceptance keeps its saved scope and evidence; only edited wording and relationship flags may be supplied.");
    else words.push(value);
  }
  if (words.length > 1) noteArgumentError("NOTE_OPTION_INVALID", "Provide edited draft wording as one quoted argument.");
  const scope = currentStackScope();
  if (!scope) noteArgumentError("STACK_REQUIRED", "Choose the draft's stack with --stack <name>.");
  let draft;
  try { draft = readDraftNote(root, id, { scope }); }
  catch (error) { noteRefusal({ refused: /^DRAFT_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "DRAFT_UNAVAILABLE",
    reason: "The local draft or its current scope and evidence could not be validated. No note was saved.",
    next: "Inspect the original request and selected stack; run a new explicitly authorized request if new evidence is needed." }); }
  const text = words.length ? words[0] : draft.text;
  const textDigest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  if (draft.accepted && draft.accepted.text_digest !== textDigest) noteRefusal({ refused: "DRAFT_ALREADY_ACCEPTED",
    reason: "This draft was accepted with different wording. Use the saved note's supersession path for a correction." });
  const expanded = ["note", ...(draft.key.kind === "operation" ? [draft.key.op] : []), text,
    "--scope", draft.key.kind, ...relation, ...draft.evidence.flatMap(run => ["--evidence", run]),
    ...(draft.operations?.length ? ["--operations", ...draft.operations] : [])];
  return { argv: expanded, draft, textDigest };
}

function cmdNote(argv) {
  const migration = stacksMigrationRequired(repoRoot());
  if (migration) noteRefusal({ refused: migration.code, reason: migration.message, next: migration.command });
  const acceptance = draftNoteArguments(repoRoot(), argv);
  const { op, scope, operations, shared, text, relation, evidence, retires, reason, by, actor, basis, source } = noteArguments(acceptance.argv);
  let basisStamp;
  try { basisStamp = noteBasisStamp(basis, source); }
  catch (error) { noteRefusal({ refused: error.code, reason: error.message }, error.code === 'SECRET_IN_NOTE' ? 2 : 3); }
  if (retires !== undefined) {
    try {
      const result = retireNote(repoRoot(), { operation: op, retires, reason, text, by, actor, evidence, ...basisStamp });
      const pointers = result.pointers;
      console.log(JSON.stringify({ ...result, file: contextFile(), pointers }, null, 1));
      if (pointers.state === 'failed') process.exitCode = 1;
    } catch (error) { reviewWriteError(error); }
    return;
  }
  if (by !== undefined || actor !== undefined) {
    if (scope !== 'operation') noteArgumentError('NOTE_OPTION_INVALID', '--by and --actor currently apply to operation notes.');
    try { validateReviewActor(by ?? provenanceStamp(repoRoot()).by, actor === 'imported' ? 'agent' : actor ?? 'agent'); }
    catch (error) { reviewWriteError(error); }
  }
  const noteKey = scope === "stack" ? { kind: "stack" } : { kind: "operation", op };
  if (scope !== "operation" && !currentStackScope()) noteArgumentError("STACK_REQUIRED", "Choose a stack for its facts with --stack <name>.");
  if ((scope === "operation" && !op) || !text) {
    noteArgumentError("NOTE_ARGUMENTS_REQUIRED", "Provide an operation and note.", `Use: ${CLI_NAME} note "<METHOD /path>" "<what you learned>" [--json]`);
  }
  if ([op, ...operations].filter(Boolean).some(containsMachineLocalPath)) {
    noteRefusal({ refused: "MACHINE_PATH_IN_OPERATION", operation: "machine-local path", next: "Name the operation by METHOD and API path only." });
  }

  // BOTH arguments are written to the committed file — op becomes a JSON key,
  // text a value. Scanning only the text left the op position as an unguarded
  // second door: `note "https://x/hooks?access_token=xoxb-…" "see this"` wrote a
  // live token into git. A realistic path, because pasting an endpoint's
  // URL-with-token as the operation is an obvious thing for an agent to do.
  for (const field of [op, text, ...operations].filter(Boolean)) {
    const what = secretIn(field, { allowAuthReferences: true });
    if (!what) continue;
    noteRefusal({
      refused: "SECRET_IN_NOTE",
      reason: `The ${field === op ? "operation" : "note"} appears to contain ${what}. ` + (scope === "account"
        ? "Account facts must not retain credentials, including private facts."
        : `${contextFile()} is committed, so this would be permanent and in every clone and fork.`),
      next: "Remove the secret. Name an operation by its METHOD and path only " +
            "(\"POST /webhooks\"), and describe a note by SHAPE rather than value " +
            "(\"needs a bearer token from the console\").",
    }, 2);
  }

  // Notes are carried into the managed pointer block, which is delimited by
  // HTML comments and read by agents as instructions: comment markup in a note
  // could close the block early, and an unbounded note is an unbounded prompt.
  // The renderer flattens and bounds every note regardless; the CLI refuses
  // by name so the author learns why rather than finding the note rewritten.
  if ([op, text, ...operations].filter(Boolean).some(hasCommentMarkup)) {
    noteRefusal({
      refused: "MARKUP_IN_NOTE",
      reason: "Comment markup (<!-- or -->) cannot enter a note: the managed block that carries notes into agent instruction files is delimited by HTML comments.",
      next: "Describe the behavior without markup.",
    });
  }
  if (text.length > BLOCK_TEXT_MAX) {
    noteRefusal({
      refused: "NOTE_TOO_LONG",
      reason: `A note is limited to ${BLOCK_TEXT_MAX} characters; this one has ${text.length}.`,
      next: "Record the behavioral implication the next agent needs, not the evidence; evidence belongs in the evidence directory.",
    }, 1);
  }

  const root = repoRoot();
  if (scope === "account") {
    const bound = currentStackScope(), cfg = bound.config, stamp = { ...provenanceStamp(root), ...basisStamp };
    let evidenceWarnings = [];
    if (evidence.length) {
      try {
        const resolved = resolveNoteEvidence(evidence, { evidenceDir: evidenceDirectory(root),
          environment: cfg.name, provider: cfg.baseUrl, contractDigest: loadHttpContract(findContract(root, cfg))?.digest });
        if (resolved.references.some(reference => reference.state === "scope_mismatch"))
          noteArgumentError("EVIDENCE_SCOPE_MISMATCH", "The evidence belongs to another environment, provider or contract; no account fact was saved.");
        stamp.evidence = resolved.references; evidenceWarnings = resolved.warnings;
      } catch (error) { noteArgumentError(error.code?.startsWith("EVIDENCE_") ? error.code : "EVIDENCE_UNAVAILABLE", "The local evidence reference could not be read safely; no account fact was saved."); }
    }
    let result;
    try { result = writeAccountFact(root, { scope: bound, text, stamp, relation, shared }); }
    catch (error) {
      if (error.code === "SECRET_IN_NOTE") noteRefusal({ refused: error.code, reason: "The account fact contains a credential. Describe its behavior without the value." }, 2);
      if (/^(?:NOTE_|CONTEXT_|ACCOUNT_)/.test(error.code ?? "")) noteRefusal({ refused: error.code,
        reason: error.message, ...(error.existing ? { existing: error.existing } : {}),
        next: `Inspect ${CLI_NAME} show --stack ${bound.stack} --env '${cfg.name.replaceAll("'", "'\\''")}' --scope account --human --history. For another claim use --alongside or --supersedes <note-id>; repeating an unchanged fact explicitly re-confirms it for the current credential.` });
      throw error;
    }
    const recorded = result.history?.records.find(record => record.id === result.note_id)?.provenance;
    console.log(JSON.stringify({ key: result.key, stack: bound.stack, environment: cfg.name, shared,
      note_id: result.note_id, ...(result.unchanged ? { unchanged: "that active account fact is already recorded" } : { recorded: text }),
      reconfirmed: result.reconfirmed ?? false, credential_state: result.credential_state,
      by: recorded?.by ?? stamp.by, at: recorded?.at ?? stamp.at, file: result.file,
      evidence: recorded?.evidence ?? [], ...(recorded?.basis ? { basis: recorded.basis, source: recorded.source } : {}),
      evidence_attachment: result.unchanged ? "unchanged; the receipt shows the original saved references; requested references were not attached" : "the receipt lists every saved reference; evidence from superseded notes is not inherited",
      ...(evidence.length ? { [result.unchanged ? "requested_evidence_warnings" : "evidence_warnings"]: evidenceWarnings } : {}),
    }, null, 1));
    return;
  }
  const snapshot = loadContextSnapshot(root);
  const ctx = snapshot?.ctx;
  if (!ctx) {
    // The write the convention just asked the agent to make, with nowhere to
    // land: a new stack can hold authored notes without an OpenAPI contract.
    noteArgumentError("CONTEXT_UNAVAILABLE", `No ${contextFile()} here.`, noteContextHint(root));
  }

  // A note about an operation nobody has recorded is still worth keeping: the
  // whole point is capturing knowledge about endpoints the contract missed.
  const key = scope === "stack" ? undefined : Object.keys(ctx.operations).find((k) => k === op)
    ?? Object.keys(ctx.operations).find((k) => k.replace(/\/+$/, "") === op.replace(/\/+$/, ""));
  const target = key ?? op;
  const stamp = provenanceStamp(root);
  Object.assign(stamp, basisStamp);
  // Keep the established authored date (and its presentation order). The
  // precise creation time lets self-trust distinguish a later same-day run.
  if (scope === 'operation') stamp.recorded_at = new Date().toISOString();
  if (by !== undefined) stamp.by = by;
  if (actor !== undefined || by !== undefined) stamp.actor = actor ?? 'agent';
  let evidenceWarnings = [];
  if (evidence.length) {
    const cfg = resolveConfig(root);
    let resolved;
    try { resolved = resolveNoteEvidence(evidence, { evidenceDir: evidenceDirectory(root), ...(scope === "stack" ? { operations } : { operation: target }),
      environment: cfg.name, provider: cfg.baseUrl, contractDigest: loadHttpContract(findContract(root, cfg))?.digest }); }
    catch (error) { noteArgumentError(error.code?.startsWith("EVIDENCE_") ? error.code : "EVIDENCE_UNAVAILABLE", "The local evidence reference could not be read safely; no note was saved.", "Use an exact local run ID and a regular unlinked evidence file."); }
    stamp.evidence = resolved.references;
    evidenceWarnings = resolved.warnings;
  }
  let result;
  try {
    result = saveContextNote(root, snapshot, { key: noteKey, ...(scope === "stack" ? { operations } : {}), note: text, stamp, relation });
  } catch (error) {
    if (error.code === 'NOTE_REVIEW_EVIDENCE_REQUIRED') reviewWriteError(error, { operation: scope === 'operation' ? target : undefined, stack: currentStackScope()?.stack });
    noteWriteError(error, scope);
  }
  let draftReceipt;
  if (acceptance.draft) {
    try { markDraftNoteAccepted(root, acceptance.draft.id, { scope: currentStackScope(), note_id: result.note_id, text_digest: acceptance.textDigest });
      draftReceipt = { accepted_draft: acceptance.draft.id };
    } catch { draftReceipt = { accepted_draft: acceptance.draft.id, draft_receipt: "failed; the note is saved; repeat the same acceptance to retry" }; process.exitCode = 1; }
  }
  const pointers = refreshNotePointers(root);
  const savedRecord = result.history?.records.find(record => record.id === result.note_id);
  const recordedStamp = savedRecord?.provenance;
  console.log(JSON.stringify({
    ...(scope === "stack" ? { key: noteKey, stack: currentStackScope().stack } : { op: result.target }), ...(result.unchanged ? { unchanged: "that active note is already recorded" } : { recorded: text }),
    ...draftReceipt, note_id: result.note_id, by: recordedStamp?.by ?? null, at: recordedStamp?.at ?? null, file: contextFile(),
    evidence: recordedStamp?.evidence ?? [], ...(recordedStamp?.basis ? { basis: recordedStamp.basis, source: recordedStamp.source } : {}),
    evidence_attachment: result.unchanged
      ? "unchanged; the receipt shows the original saved references; requested references were not attached"
      : "the receipt lists every saved reference; evidence from superseded notes is not inherited",
    // A retry preserves the original record, including its evidence. Warnings
    // about references supplied on this invocation must not describe that record.
    ...(evidence.length ? { [result.unchanged ? "requested_evidence_warnings" : "evidence_warnings"]: evidenceWarnings } : {}), pointers,
    undeclared_operation: scope === "stack" || key ? undefined : "this operation was not in the contract; the note is kept anyway",
  }, null, 1));
  if (pointers.state === "failed") process.exitCode = 1;
}

// --- verdict ---------------------------------------------------------------
//
// The decision NOT to use an API, recorded next to the operations of the ones
// we do use (the integration acceptance rule). Accepted integrations leave code; rejected ones leave
// nothing, and someone pays the full evaluation cost again in three years. A
// verdict is the reason, the class of reason, and ideally the committed probe
// envelope that reproduces it — one line on top of work that already happened.
//
// Structure mirrors `note` deliberately: same file, same secret guard, same
// exit codes. A note is a gotcha about an API you use; a verdict is a decision
// about an API you did not.

// `--key value` flags plus bare `--revisable`. A tiny local parser beats a
// positional soup for a command with seven optional fields.
function verdictFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
    if (!m) continue;
    const key = m[1].replace(/-/g, "_");
    if (key === "revisable") { flags.revisable = true; continue; }
    flags[key] = m[2] ?? rest[++i];
  }
  return flags;
}

function cmdVerdict(argv) {
  const root = repoRoot();
  const ctx = loadContext(root);
  if (!ctx) die("NO_CONTEXT", `No ${contextFile()} in ${root}.`, initHint(root));

  if (argv[1] === "show") {
    const entries = Object.entries(ctx.verdicts ?? {});
    if (!entries.length) { console.log(`no verdicts recorded. ${CLI_NAME} verdict <target> --verdict rejected --reason <why> --class <class>`); return; }
    // Expired first: the ones that must not be read as answers lead the list.
    entries.sort(([, a], [, b]) => Number(isExpired(b)) - Number(isExpired(a)));
    for (const [name, entry] of entries)
      console.log((isExpired(entry) ? "? " : "  ") + renderVerdict(name, entry));
    return;
  }

  const target = argv[1];
  const f = verdictFlags(argv.slice(2));
  if (!target || target.startsWith("--")) {
    console.error(`usage: ${CLI_NAME} verdict "<what>" --verdict rejected|accepted|deferred --reason "<why>" --class ` +
      Object.keys(VERDICT_CLASSES).join("|") +
      ' [--scope "<what was actually evaluated>"] [--probe <envelope.json>] [--held-by org|<person>] [--revisable] [--confirmed YYYY-MM-DD] [--decided-by <who>]\n' +
      `       ${CLI_NAME} verdict show`);
    process.exit(1);
  }

  // Every free-text field is written to the committed file, so every one is a
  // door for a secret. Same guard, same exit code as `note` — verdicts are a
  // new path around the promotion boundary and get no softer treatment.
  for (const [field, value] of Object.entries({ target, reason: f.reason, scope: f.scope,
      held_by: f.held_by, decided_by: f.decided_by, probe: f.probe })) {
    const what = secretIn(value, { allowAuthReferences: true });
    if (!what) continue;
    console.error(JSON.stringify({
      refused: "SECRET_IN_VERDICT",
      reason: `The ${field} appears to contain ${what}. ${contextFile()} is committed, so this would be permanent and in every clone and fork.`,
      next: "Remove the secret. Describe the reason by SHAPE rather than value " +
            "(\"429 at 10 req/s sustained\"), and name people without email addresses.",
    }, null, 1));
    process.exit(2);
  }

  const problems = validateVerdict({ verdict: f.verdict, reason: f.reason, cls: f.class,
    scope: f.scope, held_by: f.held_by, revisable: f.revisable });
  if (problems.length)
    die("INVALID_VERDICT", problems[0],
      `verdict is one of ${VERDICT_STATES.join("|")}; class is one of ${Object.keys(VERDICT_CLASSES).join("|")}.`);

  // A probe must be a real, committed, parseable envelope. A dangling path
  // reduces the verdict to an opinion with a date on it, which is exactly the
  // alternative the ADR rejected.
  let probe;
  if (f.probe !== undefined) {
    const p = resolve(root, f.probe);
    if (!p.startsWith(root + "/"))
      die("PROBE_OUTSIDE_REPO", `${f.probe} resolves outside ${root}.`, "The probe must be committed with the repo, or re-running it is someone else's filesystem.");
    if (!existsSync(p)) die("PROBE_NOT_FOUND", `No probe envelope at ${p}.`, "Commit the envelope that reproduces the reason, then record the verdict.");
    try { JSON.parse(readFileSync(p, "utf8")); }
    catch { die("PROBE_NOT_JSON", `${f.probe} is not parseable JSON.`, "The probe must be a re-runnable envelope (the standard request envelope), not prose."); }
    probe = p.slice(root.length + 1);
  }

  // Provenance: who WROTE this verdict, and when — distinct from decided_by
  // (who HOLDS the decision) and from last_confirmed (when it was re-checked).
  // A marker, never PII (see authorMarker).
  const stamp = provenanceStamp(root);
  const entry = recordVerdict(ctx, target, {
    verdict: f.verdict, reason: f.reason, cls: f.class, scope: f.scope, probe,
    held_by: f.held_by, revisable: f.revisable, last_confirmed: f.confirmed, decided_by: f.decided_by,
    recorded_by: stamp.by, recorded_at: stamp.at,
  });
  saveContext(root, ctx);
  console.log(JSON.stringify({
    recorded: target, ...entry, file: contextFile(),
    ...(probe === undefined ? { no_probe: "recorded without a probe; this verdict is re-derivable only by repeating the evaluation" } : {}),
  }, null, 1));
}

// --- suite -----------------------------------------------------------------
//
// Saved, named, re-runnable request suites (T1) — the collection. A suite file
// is the standard request envelope's `requests` array with a name, committed under
// api-suites/<name>.json; format, guards and reporting live in lib/suites.mjs.
// `run` executes through the real runEnvelope, so a suite can never pass in
// the runner and fail in the client: they are the same code path.

function cmdSuiteSave(argv) {
  const name = argv[2];
  if (!name || name.startsWith("--")) {
    console.error(`usage: ${CLI_NAME} suite save <name> [file.json]   (or pipe the envelope on stdin)`);
    process.exit(1);
  }
  // From a file when given, stdin otherwise — the two places an envelope
  // already exists (a committed probe, or the batch an agent just ran).
  const source = argv[3] && !argv[3].startsWith("--") ? argv[3] : 0;
  let raw;
  try { raw = readFileSync(source, "utf8"); }
  catch (e) { die("SUITE_SOURCE_UNREADABLE", `Could not read ${source === 0 ? "stdin" : source}: ${e.message}`,
    "Pass a JSON file path, or pipe the envelope on stdin."); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { die("SUITE_NOT_JSON", `Input is not parseable JSON: ${e.message}`,
    'A suite is a request, an array of requests, or an envelope {"v":2,"requests":[…]}.'); }

  const { suite, problems } = normalizeSuite(name, parsed);
  if (problems.length) die(problems[0].code, problems[0].message, problems[0].next);

  // Same posture and exit code as note/verdict: the file is committed, so a
  // literal credential in it would be permanent and in every clone and fork.
  const secrets = suiteSecretProblems(suite);
  if (secrets.length) {
    console.error(JSON.stringify({
      refused: "SECRET_IN_SUITE",
      reason: secrets.map((s) => `${s.where} appears to contain ${s.what}`).join("; ") +
        `. ${SUITE_DIR}/ is committed, so this would be permanent and in every clone and fork.`,
      next: secrets[0].fix,
    }, null, 1));
    process.exit(2);
  }

  const root = repoRoot();
  const file = saveSuite(root, suite);
  console.log(JSON.stringify({
    wrote: file, name: suite.name, steps: suite.requests.length,
    next: `${CLI_NAME} suite run ${suite.name}`,
  }, null, 1));
}

async function cmdSuiteRun(argv) {
  const root = repoRoot();
  const selected = requestArgs(argv, "suite run", { booleans: ["--json"] });
  argv = selected.args;
  const cfg = selectRequestConfig(root, selected.environment);
  const asJson = argv.includes("--json");
  const named = argv[2] && !argv[2].startsWith("--") ? argv[2] : null;
  const names = named ? [named] : listSuites(root);
  if (!names.length)
    die("NO_SUITES", `No suites in ${SUITE_DIR}/.`,
      `Save one: ${CLI_NAME} suite save <name> — from a file or stdin.`);

  // The client resolves config, context and auth at module load; importing it
  // lazily keeps every other sannr command (init/show/note/…) free of
  // that work and of any env problems it might surface.
  const { runEnvelope, transportError } = await import("../lib/client.mjs");

  const reports = [];
  for (const name of names) {
    let loaded;
    try { loaded = loadSuite(root, name); }
    catch (e) {
      die(e.code, e.message, e.code === "SUITE_NOT_FOUND"
        ? (e.available.length ? `Saved suites: ${e.available.join(", ")}.` : "No suites saved yet.")
        : "Fix or re-save the file.");
    }
    const { file, suite } = loaded;
    let result;
    try {
      result = await runEnvelope({ v: suite.v, stack: suite.stack, environment: suite.environment, upstream: suite.upstream, requests: suite.requests, finally: suite.finally, reveal_captures: suite.reveal_captures, reveal_secrets: suite.reveal_secrets,
        on_failure: suite.on_failure ?? "continue" });
    } catch (e) {
      // fetch collapses ECONNREFUSED, ENOTFOUND and its bad-port list into a
      // bare "TypeError: fetch failed". A dead service is the FIRST thing a
      // smoke suite exists to detect, so it must land as a named red report
      // (same mapper bin/request.mjs uses), and in run-all mode one
      // unreachable host must not take the remaining suites' reports with it.
      result = { ok: false, results: [], captured: {},
        attempted: e.requestAttempts ?? (suite.requests.length ? 1 : 0),
        error: transportError(e) };
    }
    reports.push({ file: file.slice(root.length + 1), ...suiteReport(suite, result) });
  }

  const allOk = reports.every((r) => r.ok);
  const requestAttempts = reports.reduce((sum, report) => sum + report.request_attempts, 0);
  const targetFields = requestAttempts > 0
    ? { request_target: requestTarget(cfg) }
    : selectedRequestTargetFields([{ service: "suite", ...requestTarget(cfg) }]);
  process.exitCode = allOk ? 0 : 1;
  if (asJson) {
    console.log(JSON.stringify({ ok: allOk, ...targetFields,
      request_attempts: requestAttempts, suites: reports }, null, 2));
    return;
  }

  // Per-suite, per-step, worst news loudest: a failing step prints its exact
  // expected-vs-actual, because "assertion failed" without the two values is a
  // report that sends the reader off to re-run the request by hand.
  const val = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s ?? "null"; };
  console.log(`${requestAttempts > 0 ? requestTargetLine(cfg)
    : `selected ${requestTargetLine(cfg)} (not executed)`}\n`);
  for (const r of reports) {
    console.log(`suite ${r.name} — ${r.passed}/${r.total} passed  (${r.file})`);
    // A suite-level cause (dead host, EMPTY_ENVELOPE, version mismatch) prints
    // before the steps: rows of "not run" with the reason nowhere is a report
    // that makes the reader re-derive it by hand.
    if (r.error) console.log(`  ERROR   ${r.error.code}: ${r.error.message}${r.error.next ? `  → ${r.error.next}` : ""}`);
    for (const s of r.steps) {
      const mark = s.ok === null ? "  not run" : s.ok ? "  pass" : "  FAIL";
      console.log(`${mark}  ${s.id.padEnd(10)} ${s.op}  [${s.checks} check${s.checks === 1 ? "" : "s"}]`);
      for (const f of s.failures ?? [])
        console.log(`          ${f.target}${f.path != null ? ` ${f.path}` : ""} ${f.ops ? `${f.ops.join("+")}: ${f.op} failed${f.refused_ops ? `, ${f.refused_ops.join("+")} refused${f.code ? ` (${f.code})` : ""}` : ""} —` : `${f.op}:`} expected ${val(f.expected)}, actual ${val(f.actual)}`);
      if (s.error) console.log(`          ${s.error.code}: ${s.error.message}`);
    }
    for (const item of r.left_behind ?? []) console.log(`  left behind  ${item.created_by}: capture ${item.capture}${item.delete_status !== undefined ? ` (DELETE returned ${item.delete_status})` : ""}`);
    console.log("");
  }
  console.log(allOk ? `ok — ${reports.length} suite${reports.length === 1 ? "" : "s"} green.`
    : `exit 1 — ${reports.filter((r) => !r.ok).length} of ${reports.length} suite${reports.length === 1 ? "" : "s"} failing.`);
}

function cmdSuiteList() {
  const root = repoRoot();
  const names = listSuites(root);
  if (!names.length) {
    console.log(`no suites in ${SUITE_DIR}/. Save one: ${CLI_NAME} suite save <name>`);
    return;
  }
  for (const name of names) {
    try {
      const { suite } = loadSuite(root, name);
      const n = suite.requests?.length ?? 0;
      console.log(`  ${name.padEnd(24)} ${n} step${n === 1 ? "" : "s"}  ${SUITE_DIR}/${name}.json`);
    } catch { console.log(`  ${name.padEnd(24)} (unreadable)  ${SUITE_DIR}/${name}.json`); }
  }
}

async function cmdSuite(argv) {
  // `--env` belongs to the request-executing `run` subcommand, but top-level
  // help advertises it as a suite option too. Recognize both placements while
  // leaving save/list entirely outside request-config resolution.
  let sub = argv[1];
  if (sub === "--env") sub = argv[3];
  else if (sub?.startsWith("--env=")) sub = argv[2];
  if (sub === "save") cmdSuiteSave(argv);
  else if (sub === "run") await cmdSuiteRun(argv);
  else if (sub === "list") cmdSuiteList();
  else {
    console.error(`usage: ${CLI_NAME} suite save <name> [file.json]   save a suite from a file or stdin
       ${CLI_NAME} suite run [name] [--json]        run one suite, or all of them
       ${CLI_NAME} suite list                       what is saved, and how big`);
    process.exit(1);
  }
}

// --- import ----------------------------------------------------------------
//
// Postman v2.1/v3, Insomnia v4, or Bruno → a suite, an environment scaffold, a provenance manifest, and
// the deliverable: the compatibility report. See docs/imports.md for the spec and
// lib/import.mjs for the rules (secrets never cross; no step imports without
// an assertion; deterministic output; the source is never modified).

async function cmdImport(argv) {
  try { return await cmdImportInput(argv); }
  catch (error) {
    die(typeof error?.code === "string" ? error.code : "IMPORT_SOURCE_UNPARSEABLE",
      "Import source at $: input and output paths must be readable regular files or supported collection directories, and documents must satisfy import rules.",
      "Repair the source or destination, then re-run the import command.");
  }
}

async function cmdImportInput(argv) {
  if (argv[1] === "workspace") {
    const { flattenPostmanCaptureDir, writeFlattenedWorkspace } = await import("../lib/postman-workspace.mjs");
    const { stableStringify } = await import("../lib/import.mjs");
    const captureDir = argv[2];
    if (!captureDir || !existsSync(captureDir))
      die("POSTMAN_CAPTURE_NOT_FOUND", `No Postman capture directory at ${captureDir ?? "(none given)"}.`,
        `${CLI_NAME} import workspace ../postman-corpus [--out <dir>]`);
    const outputFlag = flagValue(argv, "--out");
    const directOutput = true;
    const root = outputFlag
      ? resolveUserOutputPath(repoRoot(), outputFlag, { allowOutside: argv.includes("--allow-outside-project"), directory: true })
      : resolveUserOutputPath(repoRoot(), join(captureDir, "flattened"), { defaultInside: true, directory: true });
    let previous = null;
    const rollupPath = join(directOutput ? root : join(root, LAYOUT.suites), "postman-workspace.rollup.json");
    safeOutputPath(rollupPath);
    if (existsSync(rollupPath)) previous = JSON.parse(readFileSync(rollupPath, "utf8"));
    let flattened;
    try { flattened = flattenPostmanCaptureDir(captureDir, { previousRollup: previous }); }
    catch (error) { die(error.code ?? "POSTMAN_WORKSPACE_IMPORT_FAILED", "Postman capture at $: capture.json must contain a valid workspace and the directory must contain only bounded regular files.", "Repair the capture, then re-run the same import command."); }
    if (argv.includes("--json")) { console.log(stableStringify(flattened.rollup)); return; }
    for (const diff of flattened.rollup.diffs) {
      if (!diff.drift) continue;
      console.log(`${diff.name}: ${diff.drift.same_source ? "source unchanged" : `source drift (added ${diff.drift.added.length}, removed ${diff.drift.removed.length}, changed ${diff.drift.changed.length})`}`);
    }
    if (!argv.includes("--dry-run")) {
      const result = writeFlattenedWorkspace(root, flattened, { direct: directOutput });
      console.log(`wrote ${result.collections.length} suites and ${result.rollupPath}`);
      console.log(`environment facts: ${Object.keys(result.environmentFacts).length} environment(s), names only`);
    } else console.log("(dry run: nothing written)");
    return;
  }
  const { importPostman, importInsomnia, importBruno, importBrunoDirectory, importPostmanV3, envValues, sourceDrift, renderImportReport, stableStringify } =
    await import("../lib/import.mjs");
  const { normalizeSuite, serializeSuite, saveSuite, suitePath, suiteNameProblem, SUITE_DIR } =
    await import("../lib/suites.mjs");

  const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("-") && arr[i - 1] !== "--suite" && arr[i - 1] !== "--values" && arr[i - 1] !== "--report");
  const source = argv[1] === "kong" ? argv[2] : positional[0];
  if (!source || !existsSync(source))
    die("IMPORT_SOURCE_NOT_FOUND", `No collection file at ${source ?? "(none given)"}.`,
      `${CLI_NAME} import <collection.json|collection.yaml|request.bru> [--suite <name>] [--values <postman-env.json>] [--dry-run]`);

  let sourceText;
  let collection;
  const suiteFlag = flagValue(argv, "--suite");
  let out;
  try {
    const sourceIsDirectory = statSync(source).isDirectory();
    if (!sourceIsDirectory) sourceText = readFileSync(source, "utf8");
    if (sourceIsDirectory) {
      out = importBrunoDirectory(source, { suiteName: suiteFlag ?? undefined, sourceName: basename(source) });
    } else if (/\.bru$/i.test(source)) {
      out = importBruno(sourceText, { suiteName: suiteFlag ?? undefined, sourceName: basename(source) });
    } else if (argv[1] === "kong") {
      out = (await import("../lib/import.mjs")).importKong(sourceText, { suiteName: suiteFlag ?? basename(source, ".yaml"), sourceText });
    } else {
      try { collection = JSON.parse(sourceText); }
      catch { collection = (await import('../lib/yaml.mjs')).parseYaml(sourceText); }
      if (collection?.resources && collection?._type === "export" || /insomnia/i.test(collection?.type ?? '')) {
        out = importInsomnia(collection, { suiteName: suiteFlag ?? undefined, sourceText });
      } else if (/collection\/v2/i.test(collection?.info?.schema ?? "")) {
        const valuesFlag = flagValue(argv, "--values");
        const values = valuesFlag ? envValues(JSON.parse(readFileSync(valuesFlag, "utf8"))) : {};
        out = importPostman(collection, { values, suiteName: suiteFlag ?? undefined, sourceText });
      } else {
        out = importPostmanV3(sourceText, { suiteName: suiteFlag ?? undefined, sourceText });
      }
    }
  } catch (e) {
    die(e.code ?? "IMPORT_SOURCE_UNPARSEABLE", "Import source at $: document must satisfy the selected format and field rules",
      "Supported formats: Postman v2.1 JSON, Postman v3 YAML, Insomnia v4/v5 JSON or YAML, and Bruno .bru.");
  }

  // Re-import: an existing provenance manifest means we can name source drift
  // BEFORE overwriting anything.
  if (out.sourceKind === "kong-declarative") {
    const declarationDir = join(repoRoot(), "api-declarations");
    const declarationName = out.name;
    if (argv.includes("--json")) { console.log(stableStringify({ sourceKind: out.sourceKind, declared: out.declared, environmentFacts: out.environmentFacts, pluginFacts: out.pluginFacts, report: out.report })); return; }
    console.log(`Kong declared layer — ${out.report.counts.declared} operations, ${out.report.counts.skipped} skipped branches`);
    for (const item of out.report.loss) console.log(`Skipped: ${summaryCell(item.name)} — ${summaryCell(item.reason)}`);
    if (argv.includes("--dry-run")) { console.log("(dry run: nothing written)"); return; }
    writeOutputFile(join(declarationDir, `${declarationName}.json`), stableStringify({ v: 1, name: declarationName, layer: "DECLARED", ...out }) + "\n", { mkdir: true });
    retainViewModel(repoRoot(), "import", out.report, { source: declarationName, basis: `Imported ${out.sourceKind}; declarations only, not executed` });
    console.log(`wrote ${join("api-declarations", `${declarationName}.json`)}`);
    return;
  }
  if (out.report?.source_kind === 'insomnia-v5-environment') {
    const nameProblem = suiteNameProblem(out.name);
    if (nameProblem) die(nameProblem.code, nameProblem.message, nameProblem.next);
    if (argv.includes('--json')) { console.log(stableStringify({ report: out.report, environmentFacts: out.environmentFacts })); return; }
    console.log(renderImportReport(out.report, { cli: CLI_NAME }));
    if (argv.includes('--dry-run')) { console.log('(dry run: nothing written)'); return; }
    const factsPath = join(repoRoot(), SUITE_DIR, `${out.name}.environment-facts.json`);
    writeOutputFile(factsPath, stableStringify({ source_kind: out.report.source_kind, environments: out.environmentFacts }) + '\n', { mkdir: true });
    console.log(`wrote ${factsPath}; variable names only, no runnable suite or API knowledge`);
    return;
  }
  // A todo step can carry the same named auth reference as a runnable step.
  // Permit only that typed field; prose and arbitrary metadata remain scanned.
  const scanSecrets = (v, path = []) => typeof v === "string"
    ? path.length === 2 && Number.isInteger(path[0]) && path[1] === "auth"
      ? parseAuthReference(v, { prose: true }) && !secretIn(v, { allowAuthReferences: true }) ? false : secretIn(v, { allowAuthReferences: true }) || secretIn(v)
      : secretIn(v)
    : Array.isArray(v) ? v.some((x, i) => scanSecrets(x, [...path, i]))
    : v && typeof v === "object" ? Object.entries(v).some(([k, x]) => secretIn(k) || scanSecrets(x, [...path, k])) : false;
  if (scanSecrets(out.todo))
    die("IMPORT_SECRET_REFUSED", "The importer produced a secret-shaped value; nothing was written or printed.", "Repair the importer before writing or printing this result.");
  const intakeCheck = normalizeSuite(out.name, out.suite);
  if (intakeCheck.problems?.[0]?.code === 'SUITE_EMPTY') {
    // Parsing an export is not a runnable test suite. Keep its named losses
    // inspectable without writing or retracting operation knowledge.
    if (argv.includes('--json')) console.log(stableStringify({ state: 'needs-work', code: 'SUITE_EMPTY', context_unchanged: true,
      report: out.report, suite: out.suite, todo: out.todo }));
    else {
      console.log(renderImportReport(out.report, { cli: CLI_NAME }));
      if (!argv.includes('--dry-run')) {
        const lossPath = join(repoRoot(), SUITE_DIR, `${out.name}.import-losses.json`);
        writeOutputFile(lossPath, stableStringify({ state: 'needs-work', code: 'SUITE_EMPTY', context_unchanged: true,
          report: out.report, todo: out.todo, provenance: out.provenance }) + '\n', { mkdir: true });
        console.log(`wrote ${lossPath}; no runnable suite or API knowledge was written`);
      }
      console.error('SUITE_EMPTY: every request needs review; no runnable assertions survived import.');
    }
    process.exitCode = 1;
    return;
  }
  if (intakeCheck.problems?.length)
    die(intakeCheck.problems[0].code, intakeCheck.problems[0].message, intakeCheck.problems[0].next);
  const root = repoRoot();
  const provPath = join(root, SUITE_DIR, `${out.name}.provenance.json`);
  let previousProvenance = null;
  for (const suffix of ['.json', '.todo.json', '.provenance.json']) safeOutputPath(join(root, SUITE_DIR, `${out.name}${suffix}`));
  if (existsSync(provPath)) {
    const prev = previousProvenance = JSON.parse(readFileSync(provPath, "utf8"));
    const drift = sourceDrift(prev, out.provenance);
    if (drift && !drift.same_source && !argv.includes("--json")) {
      console.log(`source drift since last import (${prev.imported_at ?? "undated"}):`);
      for (const k of drift.added) console.log(`  added    ${k}`);
      for (const k of drift.removed) console.log(`  removed  ${k}`);
      for (const k of drift.changed) console.log(`  changed  ${k}`);
      console.log("");
    } else if (drift && !argv.includes("--json")) console.log("source unchanged since last import.\n");
  }

  const normalizedForGate = normalizeSuite(out.name, out.suite);
  const suiteSecrets = normalizedForGate.suite ? (await import("../lib/suites.mjs")).suiteSecretProblems(normalizedForGate.suite) : [];
  if (suiteSecrets.length)
    die("IMPORT_SECRET_REFUSED", "The importer produced a secret-shaped value; nothing was written or printed.", "Repair the importer before writing or printing this result.");
  const report = renderImportReport(out.report, { cli: CLI_NAME });
  if (argv.includes("--json")) { console.log(stableStringify({ report: out.report, suite: out.suite, todo: out.todo })); return; }
  console.log(report);
  const reportFlag = flagValue(argv, "--report");
  if (reportFlag) writeOutputFile(resolveUserOutputPath(repoRoot(), reportFlag, { allowOutside: argv.includes("--allow-outside-project") }), report + "\n");
  if (argv.includes("--dry-run")) { console.log("\n(dry run: nothing written)"); return; }

  // Writes: the suite (through the same validator/guards as `suite save`, so
  // the secret guard and mandatory-expect rule hold on this path too), the
  // todo sidecar, and the provenance manifest with the timestamp stamped here
  // (the library stays pure).
  const norm = normalizeSuite(out.name, out.suite);
  const secretHits = norm.suite ? (await import("../lib/suites.mjs")).suiteSecretProblems(norm.suite) : [];
  if (norm.problems?.length || secretHits.length)
    die("IMPORT_PRODUCED_INVALID_SUITE",
      `Converted suite failed validation: ${(norm.problems?.[0] ?? secretHits[0]).message}`,
      "This is an importer bug — please report it with the collection (secrets are omitted before this point).");
  const preparedClaims = prepareImportedTestClaims(out, { bindings: importedClaimBindings(resolveConfig(root)) });
  saveSuite(root, norm.suite);            // creates SUITE_DIR; todo/prov follow it
  if (out.todo.length)
    writeOutputFile(join(root, SUITE_DIR, `${out.name}.todo.json`), stableStringify(out.todo) + "\n");
  const unchangedSource = previousProvenance && sourceDrift(previousProvenance, out.provenance)?.same_source;
  writeOutputFile(provPath, stableStringify({ ...out.provenance,
    imported_at: unchangedSource ? previousProvenance.imported_at : new Date().toISOString().slice(0, 10) }) + "\n");
  const claimReceipt = saveImportedTestClaims(root, preparedClaims);
  if (preparedClaims) {
    console.log(`imported test knowledge: ${claimReceipt.state}; ${claimReceipt.claims} source claims (import does not verify them)`);
    // Refresh only existing owned blocks. Import never installs an agent host.
    const plans = planPointers(root, loadContext(root), advertisementPlan(root))
      .filter(p => existsSync(p.path) && readFileSync(p.path, 'utf8').includes(BEGIN));
    for (const plan of plans) {
      if (plan.action === 'conflict') console.log(`pointer not refreshed: ${plan.file} (${plan.reason})`);
      else if (plan.action !== 'unchanged') { applyPointerPlans([plan]); console.log(`updated ${plan.file}`); }
    }
  }
  retainViewModel(root, "import", out.report, { source: out.name, basis: `Imported ${out.report.source_kind}; translated and inferred assertions, not executed` });
  console.log(`\nwrote ${suitePath(root, out.name)}${out.todo.length ? ` (+${out.todo.length} steps in ${out.name}.todo.json)` : ""}`);
  console.log(`next: ${CLI_NAME} suite run ${out.name}   — execute it with evidence; that is the half no other importer does.`);
}

// --- Postman capture -------------------------------------------------------

async function cmdPostman(argv) {
  if (argv[1] !== "capture") {
    console.error(`usage: ${CLI_NAME} postman capture [--out ../postman-corpus] [--budget N]`);
    process.exit(1);
  }
  if (argv.some((arg) => arg === "--api-key" || arg.startsWith("--api-key="))) {
    const { createPostmanClient } = await import("../lib/postman.mjs");
    createPostmanClient({ apiKey: argv.find((arg) => arg.startsWith("--api-key="))?.slice(10) ?? "literal" });
  }
  const { capturePostman } = await import("../lib/postman.mjs");
  const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const result = await capturePostman({ outputDir: value("--out") ?? "../postman-corpus",
      account: value("--account") ?? "Postman account", budget: Number(value("--budget") ?? 100) });
    console.log(JSON.stringify({ wrote: result.dir, calls: result.calls,
      redactions: result.capture.redactions }, null, 1));
  } catch (error) {
    die(error.code ?? "POSTMAN_CAPTURE_FAILED", error.message,
      error.gap ? `Gap: ${error.gap}. Re-run with a larger --budget or inspect the account.` : "Set POSTMAN_API_KEY in .env and retry.");
  }
}

// --- verify ----------------------------------------------------------------
//
// Committed suites as conformance probes (T2): run every saved suite against
// the live API and report what NO LONGER holds, each failing assertion as
// drift with expected-vs-actual. Same loader, same runEnvelope, same
// suiteReport as `suite run` — the plan/reduction logic lives in lib/verify.mjs
// and the difference in posture is documented there. verify itself adds no
// shared context: it explicitly disables request capture and never rewrites a
// suite file. Against a production environment the
// client's own guard refuses any write step a suite carries.

async function cmdVerify(argv) {
  const root = repoRoot();
  const selected = requestArgs(argv, "verify", { booleans: ["--json", "--ci", "--read-only"] });
  argv = selected.args;
  const cfg = selectRequestConfig(root, selected.environment);
  const asJson = argv.includes("--json");
  const asCi = argv.includes("--ci");
  const readOnly = argv.includes("--read-only");
  const named = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
  const names = named ? [named] : listSuites(root);
  if (!names.length)
    die("NO_SUITES", `No suites in ${SUITE_DIR}/ — nothing to verify.`,
      `Save one: ${CLI_NAME} suite save <name> — from a file or stdin.`);

  // Lazy for the same reason as cmdSuiteRun: only the commands that execute
  // requests should pay for (or surface problems from) client-side config.
  const { runEnvelope, transportError } = await import("../lib/client.mjs");

  const reports = [];
  for (const name of names) {
    let loaded;
    try { loaded = loadSuite(root, name); }
    catch (e) {
      die(e.code, e.message, e.code === "SUITE_NOT_FOUND"
        ? (e.available.length ? `Saved suites: ${e.available.join(", ")}.` : "No suites saved yet.")
        : "Fix or re-save the file.");
    }
    const { file, suite } = loaded;
    const { retained, skipped, finally: cleanup } = readOnly
      ? readOnlyPlan(suite) : { retained: suite.requests, skipped: [], finally: suite.finally };

    let report;
    if (!retained.length) {
      // Every step was skipped by the read-only plan. Not drift — the skip was
      // asked for — but it must never read as a verified suite, so the report
      // says loudly that nothing was checked. (suiteReport would call zero
      // steps red as vacuous green; here the emptiness is deliberate.)
      report = { name: suite.name, ok: true, passed: 0, total: 0, steps: [],
        request_attempts: 0,
        note: "no read steps: every step is a write, so --read-only verified nothing here" };
    } else {
      let result;
      try {
        result = await runEnvelope({ v: suite.v, stack: suite.stack, environment: suite.environment, upstream: suite.upstream, requests: retained.map(request => ({ ...request, capture_context: false })),
          finally: cleanup?.map(request => ({ ...request, capture_context: false })), reveal_captures: suite.reveal_captures, reveal_secrets: suite.reveal_secrets,
          on_failure: suite.on_failure ?? "continue" });
      } catch (e) {
        // Dead host: the FIRST thing a scheduled probe exists to notice, so it
        // must land as a named red report, not an uncaught fetch crash.
        result = { ok: false, results: [], captured: {},
          attempted: e.requestAttempts ?? (retained.length ? 1 : 0),
          error: transportError(e) };
      }
      report = suiteReport({ ...suite, requests: retained, finally: cleanup }, result);
    }
    if (skipped.length) report.skipped = skipped;
    reports.push({ file: file.slice(root.length + 1), ...report });
  }

  const drift = driftFrom(reports);
  const allOk = reports.every((r) => r.ok);
  const requestAttempts = reports.reduce((sum, report) => sum + report.request_attempts, 0);
  const targetFields = requestAttempts > 0
    ? { request_target: requestTarget(cfg) }
    : selectedRequestTargetFields([{ service: "verify", ...requestTarget(cfg) }]);
  process.exitCode = allOk ? 0 : 1;
  const mode = readOnly ? "read-only" : "full";

  if (asJson) {
    console.log(JSON.stringify({ ok: allOk, ...targetFields,
      request_attempts: requestAttempts, mode, suites: reports, drift }, null, 2));
    return;
  }

  const val = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s ?? "null"; };
  const drifted = reports.filter((r) => !r.ok);
  const checked = reports.reduce((n, r) => n + r.steps.reduce((m, s) => m + (s.ok === null ? 0 : s.checks), 0), 0);
  const skippedCount = reports.reduce((n, r) => n + (r.skipped?.length ?? 0), 0);

  console.log(`verify (${mode}) — ${reports.length} suite${reports.length === 1 ? "" : "s"}\n` +
    `  ${requestAttempts > 0 ? requestTargetLine(cfg)
      : `selected ${requestTargetLine(cfg)} (not executed)`}\n`);
  for (const r of reports) {
    // --ci keeps the log to what a pipeline reader acts on: the suites that
    // drifted, with their evidence. A green suite is one line of noise there,
    // but the full listing stays the default for a human at a terminal.
    if (asCi && r.ok && !r.note) continue;
    console.log(`suite ${r.name} — ${r.passed}/${r.total} hold  (${r.file})`);
    if (r.error) console.log(`  ERROR  ${r.error.code}: ${r.error.message}${r.error.next ? `  → ${r.error.next}` : ""}`);
    if (r.note) console.log(`  ${r.note}`);
    for (const s of r.steps) {
      if (s.ok && asCi) continue;
      const mark = s.ok === null ? "  not run" : s.ok ? "  hold " : "  DRIFT";
      console.log(`${mark}  ${s.id.padEnd(10)} ${s.op}  [${s.checks} check${s.checks === 1 ? "" : "s"}]`);
      for (const f of s.failures ?? [])
        console.log(`          ${f.target}${f.path != null ? ` ${f.path}` : ""} ${f.ops ? `${f.ops.join("+")}: ${f.op} failed${f.refused_ops ? `, ${f.refused_ops.join("+")} refused${f.code ? ` (${f.code})` : ""}` : ""} —` : `${f.op}:`} expected ${val(f.expected)}, actual ${val(f.actual)}`);
      if (s.error) console.log(`          ${s.error.code}: ${s.error.message}`);
    }
    for (const s of r.skipped ?? [])
      console.log(`  skip   ${s.id.padEnd(10)} ${s.op}  — ${s.reason}`);
    console.log("");
  }
  console.log(allOk
    ? `ok — every recorded claim holds: ${checked} assertion${checked === 1 ? "" : "s"} across ` +
      `${reports.length} suite${reports.length === 1 ? "" : "s"}` +
      (skippedCount ? ` (${skippedCount} write step${skippedCount === 1 ? "" : "s"} skipped: --read-only).` : ".")
    : `exit 1 — drift: ${drift.length} claim${drift.length === 1 ? "" : "s"} no longer hold${drift.length === 1 ? "s" : ""} ` +
      `across ${drifted.length} of ${reports.length} suite${reports.length === 1 ? "" : "s"}.`);
}

// --- review / prune --------------------------------------------------------
//
// Curation as a byproduct of a quick pass. `review` names the entries worth a
// second look (age-stale, source-moved, shape-diverged, superseded — see
// lib/curate.mjs) and says WHY, plus the confidence reason. Acting on one is a
// single explicit command: --confirm re-dates it (I looked, it holds), --drop
// removes it. `prune` is the batch drop for named candidates. Nothing is ever
// deleted without the operation being NAMED on the command line — no bulk
// silent purge exists to invoke — and --dry-run previews any of it, writing
// nothing. review with no action never writes.

// The operation keys the contract ON DISK declares, for the superseded axis.
// Null when the contract cannot be read: superseded then abstains rather than
// flagging every entry as dropped because the spec briefly went missing.
function contractOpSet(root, ctx) {
  if (!ctx?.api?.contract) return null;
  try {
    const { doc } = readContract(resolve(root, ctx.api.contract));
    return new Set(operationsFrom(doc).map((o) => o.op));
  } catch { return null; }
}

// Resolve a user-typed operation to a real key: exact, then trailing-slash
// insensitive — the same lenient match `note` uses, so "GET /x/" finds "GET /x".
const resolveOpKey = (ctx, op) =>
  (op in ctx.operations) ? op
    : Object.keys(ctx.operations).find((k) => k.replace(/\/+$/, "") === op.replace(/\/+$/, "")) ?? null;

// The value after a flag, or undefined if the flag is absent, or null if it is
// present with no operation following it (so "--drop" alone is a usage error,
// distinct from "--drop GET /x").
const flagValue = (argv, name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
};

function cmdReview(argv) {
  if (argv.slice(1).some(value => ['--note', '--decision', '--by', '--actor', '--limits', '--reason', '--evidence'].includes(value.split('=')[0]))
    || argv[1] && !argv[1].startsWith('--')) {
    try {
      const args = { notes: [], evidence: [] }, words = [];
      for (let i = 1; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--json') continue;
        if (!flag.startsWith('--')) { words.push(flag); continue; }
        const key = { '--note': 'notes', '--evidence': 'evidence', '--decision': 'decision', '--by': 'by', '--actor': 'actor', '--limits': 'limits', '--reason': 'reason' }[flag];
        if (!key) throw reviewError('NOTE_REVIEW_INVALID');
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw reviewError(key === 'notes' ? 'NOTE_DIGEST_REQUIRED' : key === 'reason' ? 'NOTE_REVIEW_REASON_REQUIRED'
          : key === 'by' ? 'NOTE_REVIEW_BY_REQUIRED' : key === 'actor' ? 'NOTE_REVIEW_ACTOR_REQUIRED' : key === 'decision' ? 'NOTE_REVIEW_DECISION_INVALID' : 'NOTE_REVIEW_INVALID');
        if (Array.isArray(args[key])) args[key].push(value);
        else { if (args[key] !== undefined) throw reviewError('NOTE_REVIEW_INVALID'); args[key] = value; }
      }
      if (words.length !== 1) throw reviewError('NOTE_REVIEW_INVALID');
      args.operation = words[0];
      const result = recordNoteReview(repoRoot(), args);
      console.log(JSON.stringify(result, null, 1));
      if (result.pointers.state === 'failed') process.exitCode = 1;
    } catch (error) { reviewWriteError(error); }
    return;
  }
  const root = repoRoot();
  const snapshot = loadContextSnapshot(root);
  const ctx = snapshot?.ctx;
  if (!ctx) die("NO_CONTEXT", `No ${contextFile()} in ${root}.`, initHint(root));

  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");
  const digest = liveContractDigest(root, ctx);
  const contractOps = contractOpSet(root, ctx);
  const opts = { digest, contractOps, expectedDigest: snapshot.digest };

  const confirmOp = flagValue(argv, "--confirm");
  const dropOp = flagValue(argv, "--drop");
  const reviewScope = flagValue(argv, "--scope");
  if (reviewScope !== undefined && reviewScope !== "stack") die("REVIEW_ACTION_INVALID", "Use --scope stack only for stack note history.");
  const stackReview = reviewScope === "stack";
  if (stackReview && (!currentStackScope() || !argv.includes("--accept-notes"))) die("REVIEW_ACTION_INVALID", "Stack history review requires --stack, --accept-notes and --if-notes.");
  const acceptOp = stackReview && argv.includes("--accept-notes") ? "stack" : flagValue(argv, "--accept-notes");
  const ifNotes = flagValue(argv, "--if-notes");
  if ([confirmOp, dropOp, acceptOp].filter(value => value !== undefined).length > 1)
    die("REVIEW_ACTION_INVALID", "Choose one review action.");
  if (acceptOp !== undefined) {
    if (!acceptOp || !ifNotes) die("NOTE_DIGEST_REQUIRED", "Reviewed baseline acceptance needs an operation and its current full digest.", `${CLI_NAME} review --accept-notes "GET /path" --if-notes sha256:<64-hex>`);
    if (dryRun) {
      const target = stackReview ? "stack" : resolveOpKey(ctx, acceptOp);
      if (!target) die("OPERATION_NOT_FOUND", "The named operation is not recorded.");
      const history = inspectNoteHistory(stackReview ? ctx.stack_facts : ctx.operations[target], target);
      if (history.review_changed) die("NOTE_REVIEW_HISTORY_CHANGED", "Review metadata differs from its separate baseline; note-history acknowledgement cannot accept it.");
      if (history.state === "invalid" || history.digest !== ifNotes) die("NOTE_REVIEW_CONFLICT", "The supplied digest does not identify a valid current history.");
      console.log(JSON.stringify({ would_accept_notes: target, dry_run: true, note_history: history }, null, 1));
      return;
    }
    try {
      const result = acceptNoteHistory(root, snapshot, { ...(stackReview ? { key: { kind: "stack" } } : { operation: acceptOp }), expectedDigest: ifNotes, stamp: provenanceStamp(root) });
      const pointers = refreshNotePointers(root, "Repeat the same reviewed acceptance command to retry pointer refresh; the acknowledgement is idempotent.");
      console.log(JSON.stringify({ accepted_notes: result.target, unchanged: result.unchanged, note_history: result.history, file: contextFile(), pointers }, null, 1));
      if (pointers.state === "failed") process.exitCode = 1;
    } catch (error) { noteWriteError(error, stackReview ? "stack" : "operation"); }
    return;
  }
  if (ifNotes !== undefined) die("REVIEW_ACTION_INVALID", "--if-notes is only valid with --accept-notes.");
  if (confirmOp === null || dropOp === null)
    die("MISSING_OPERATION", "--confirm and --drop each need an operation.",
      `Name it: ${CLI_NAME} review --drop "GET /path"`);
  if (confirmOp !== undefined) return reviewConfirm(root, ctx, confirmOp, opts, dryRun, asJson);
  if (dropOp !== undefined) return dropOps(root, ctx, [dropOp], opts, dryRun, asJson, "drop");

  // No action: list. This branch never writes, dry-run or not.
  const candidates = reviewCandidates(ctx, root, opts);
  if (asJson) { console.log(JSON.stringify({ candidates, dry_run: dryRun }, null, 2)); return; }

  if (!candidates.length) {
    console.log(`${CLI_NAME} review — no curation candidates.`);
    console.log(`  every entry is fresh, its source is where it was mapped, and it is still in the contract.`);
    return;
  }
  console.log(`${CLI_NAME} review — ${candidates.length} curation candidate${candidates.length === 1 ? "" : "s"} in ${contextFile()}\n`);
  for (const c of candidates) {
    for (const r of c.reasons) console.log(`  ${c.op.padEnd(28)} ${r.kind}: ${r.why}`);
    console.log(`  ${"".padEnd(28)} confidence: ${c.confidence} — ${c.confidenceReason}\n`);
  }
  console.log(`Act on one (curation is a quick pass, not a purge):`);
  console.log(`  ${CLI_NAME} review --confirm "<op>"   re-date / re-verify — you looked, it holds`);
  console.log(`  ${CLI_NAME} review --drop "<op>"      remove this one entry (explicit)`);
  console.log(`  ${CLI_NAME} prune "<op>" ["<op>"…]     drop named candidates in a batch`);
  console.log(`Nothing is removed without --drop or prune. --dry-run previews, writes nothing.`);
}

function reviewWriteError(error, target) {
  const receipt = noteReviewFailure(error, target);
  noteRefusal(receipt, receipt.refused === 'SECRET_IN_REVIEW' ? 2 : 3);
}

// confirm — re-date the entry to now and clear the two flags a fresh look
// settles (a recorded shape divergence, a moved contract digest). Structural
// facts confirm CANNOT change — a source file that is still gone, an operation
// still absent from the contract — survive, so those candidates honestly stay
// candidates until dropped. Re-dating is the human saying "I checked it live";
// it stamps provenance like a note or a promoted observation does.
function reviewConfirm(root, ctx, op, opts, dryRun, asJson) {
  const key = resolveOpKey(ctx, op);
  if (!key) die("OPERATION_NOT_FOUND", `No operation matching '${op}'.`, `Run: ${CLI_NAME} review`);
  const history = inspectNoteHistory(ctx.operations[key], key);
  if (["invalid", "changed"].includes(history.state)) noteWriteError(Object.assign(new Error("Review changed or malformed note history before confirming the operation."), {
    code: history.state === "invalid" ? "NOTE_HISTORY_INVALID" : "NOTE_HISTORY_CHANGED", operation: key, digest: history.digest,
  }));
  const before = reviewCandidateFor(ctx.operations[key], key, root, opts);
  if (dryRun) {
    const out = { would_confirm: key, dry_run: true,
      was_candidate: before ? before.reasons.map((r) => r.kind) : [] };
    console.log(asJson ? JSON.stringify(out, null, 2)
      : `--dry-run: would re-date ${key}${before ? ` (candidate: ${before.reasons.map((r) => r.kind).join(", ")})` : ""}. Nothing written.`);
    return;
  }
  const stamp = provenanceStamp(root);
  const e = ctx.operations[key];
  e.verified_at = new Date().toISOString();
  e.contract_digest = opts.digest ?? e.contract_digest;
  e.verified_by = stamp.by;
  e.confirmed_at = stamp.at;                        // when the human re-confirmed it
  delete e.shape_diverged_at;
  try { saveContext(root, ctx, { expectedDigest: opts.expectedDigest }); }
  catch (error) { noteWriteError(error); }
  const still = reviewCandidateFor(e, key, root, opts);
  const out = { confirmed: key, at: stamp.at, by: stamp.by,
    ...(still ? { still_a_candidate: still.reasons.map((r) => r.kind) } : {}), file: contextFile() };
  console.log(asJson ? JSON.stringify(out, null, 2)
    : `confirmed ${key} — re-dated ${stamp.at} by ${stamp.by}.` +
      (still ? ` Still a candidate (${still.reasons.map((r) => r.kind).join(", ")}); confirm cannot change that — drop it if it should go.` : ""));
}

// drop — remove ONLY the named operations. Every op is named explicitly on the
// command line; there is no wildcard, no "drop all", no kind selector that
// removes in bulk. A name that resolves to nothing is an error, not a silent
// no-op, so a typo never reads as "done".
function dropOps(root, ctx, ops, opts, dryRun, asJson, verb) {
  const dropped = [], missing = [];
  for (const op of ops) {
    const key = resolveOpKey(ctx, op);
    if (key) dropped.push(key); else missing.push(op);
  }
  if (!dropped.length)
    die("OPERATION_NOT_FOUND", `No operation matching ${missing.map((m) => `'${m}'`).join(", ")}.`,
      `Run: ${CLI_NAME} review — the exact keys are listed there.`);

  const detail = dropped.map((key) => {
    const c = reviewCandidateFor(ctx.operations[key], key, root, opts);
    return { op: key, was_candidate: c ? c.reasons.map((r) => r.kind) : [] };
  });
  const protectedOps = dropped.filter(key => inspectNoteHistory(ctx.operations[key], key).records.some(record => record.kind !== "machine")
    || ctx.operations[key].note_replacements?.length || ctx.operations[key].note_integrity?.acknowledgements?.length);
  const suspect = dropped.filter(key => ["invalid", "changed"].includes(inspectNoteHistory(ctx.operations[key], key).state));
  if (protectedOps.length || suspect.length)
    die("NOTE_HISTORY_PROTECTED", "Removing these operations would erase authored, unattributed or suspect note history.", "Keep the operation and supersede its guidance explicitly. Review secret or personal-data redaction separately.");
  if (dryRun) {
    const out = { [`would_${verb}`]: detail, missing, dry_run: true };
    if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
    for (const d of detail)
      console.log(`--dry-run: would remove ${d.op}${d.was_candidate.length ? ` (${d.was_candidate.join(", ")})` : " (not currently a candidate)"}.`);
    console.log("Nothing written.");
    return;
  }
  for (const key of dropped) delete ctx.operations[key];
  try { saveContext(root, ctx, { expectedDigest: opts.expectedDigest }); }
  catch (error) { noteWriteError(error); }
  const out = { [`${verb}ped`]: dropped, ...(missing.length ? { missing } : {}), file: contextFile() };
  if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`${verb === "drop" ? "dropped" : "pruned"} ${dropped.length} entr${dropped.length === 1 ? "y" : "ies"}: ${dropped.join(", ")}.`);
  if (missing.length) console.log(`not found (nothing removed for these): ${missing.join(", ")}`);
}

function cmdPrune(argv) {
  const root = repoRoot();
  const snapshot = loadContextSnapshot(root);
  const ctx = snapshot?.ctx;
  if (!ctx) die("NO_CONTEXT", `No ${contextFile()} in ${root}.`, initHint(root));
  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");
  const ops = argv.slice(1).filter((a) => !a.startsWith("--"));
  if (!ops.length) {
    console.error(`usage: ${CLI_NAME} prune "<op>" ["<op>"…] [--dry-run]   drop named curation candidates (explicit)`);
    process.exit(1);
  }
  const digest = liveContractDigest(root, ctx);
  dropOps(root, ctx, ops, { digest, contractOps: contractOpSet(root, ctx), expectedDigest: snapshot.digest }, dryRun, asJson, "prune");
}

// --- capabilities ----------------------------------------------------------
//
// The tool's self-report, for the two questions a security review asks first:
// what can it WRITE, and where can it SEND bytes. Built from the writers' own
// constants and the resolved config (lib/capabilities.mjs), so it cannot drift
// into a comforting fiction — a test pins the manifest to actual behaviour. The
// client-side paths (evidence, usage log, token cache, token URL) come from
// lib/client.mjs; it is imported lazily so no other command pays for its
// config-resolution work.

async function cmdCapabilities(argv) {
  const root = repoRoot();
  const cfg = resolveConfig(root);
  const { EVIDENCE, USAGE_LOG, TOKEN_CACHE, configuredOAuthTokenUrls } = await import("../lib/client.mjs");
  const manifest = capabilityManifest({
    root, config: cfg,
    evidence: EVIDENCE, usageLog: USAGE_LOG, tokenCache: TOKEN_CACHE, oauthTokenUrls: configuredOAuthTokenUrls(),
  });
  if (argv.includes("--json")) { console.log(JSON.stringify(manifest, null, 2)); return; }
  console.log(renderCapabilities(manifest));
}

// --- doctor ----------------------------------------------------------------
// The stranger's first-hour check. Every silent first-run failure this tool has
// ever cost time on — a spec that never loaded, a config typo, a base URL that
// was down, a credential env var that was never exported, a pointer nobody
// wired — becomes a NAMED line with a fix, instead of a confusing empty result
// forty minutes later. Three states: PASS (fine), FAIL (broken; drives a
// non-zero exit), WARN (works but worth knowing; never fails the exit code, so
// an opt-in like wiring can be flagged without blocking anyone).

const DOCTOR_TIMEOUT_MS = 3000;

const DEFAULT_DOCTOR_PROBE = "https://api.github.com/zen";

async function reachable(baseUrl, { json = false, targetSource = "configured" } = {}) {
  const attempts = [];
  let announcedTarget = null;
  const announce = async ({ method, url }) => {
    const target = { method, url: doctorTargetUrl(url) };
    const stream = json ? process.stderr : process.stdout;
    await new Promise((resolveWrite, rejectWrite) => stream.write(
      `About to request: ${method} ${target.url} (API client; no credentials, redirects, or retries)\n`,
      error => error ? rejectWrite(error) : resolveWrite()));
    announcedTarget = target;
  };
  try {
    let target;
    try {
      if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /[\x00-\x20\x7f-\x9f]/.test(baseUrl)) throw new Error();
      target = new URL(baseUrl);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error();
    } catch { return { ok: false, code: "URL_INVALID", attempts }; }
    const { apiReadProbe } = await import("../lib/client.mjs");
    for (const method of targetSource === "configured" ? ["HEAD", "GET"] : ["GET"]) {
      announcedTarget = null;
      const probe = await apiReadProbe({ path: baseUrl, method, onRequest: announce, targetSource }, { initiator: "cli.doctor" });
      if (probe.attempted && announcedTarget) attempts.push(announcedTarget);
      const result = probe.result;
      if (Number.isInteger(result?.status))
        return { ok: true, ...probe.response, status: result.status, evidence: result.evidence, method, attempts };
      // Only a failed HEAD fetch can justify the one GET fallback. Client
      // refusals, invalid config, local evidence errors and body bounds cannot.
      if (method === "HEAD" && probe.attempted && probe.transportFailed) continue;
      return { ok: false, code: result?.error?.code ?? probe.error?.code ?? "CLIENT_PROBE_FAILED", attempts };
    }
  } catch {
    // Module/config errors can contain literal URLs or native response bytes.
    return { ok: false, code: "CLIENT_PROBE_FAILED", attempts };
  }
}

/**
 * Ask a registered stdio server the cheapest MCP question: initialize. This
 * proves the configured command can start and speak MCP without issuing a
 * tools/call or touching the target API. A registration that only matches the
 * file shape but cannot answer this probe is not a green setup.
 */
function mcpReachable(entry) {
  if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args))
    return Promise.resolve({ ok: false, code: "invalid registration entry" });
  return new Promise((resolveProbe) => {
    let child;
    let settled = false;
    let buffer = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid && process.platform !== "win32") {
        try { process.kill(-child.pid); } catch { child.kill(); }
      } else child?.kill();
      resolveProbe(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), pinnedMcpPackage(entry) ? 30_000 : DOCTOR_TIMEOUT_MS);
    try {
      child = spawn(entry.command, entry.args, {
        cwd: process.cwd(),
        env: { ...process.env, ...(entry.env ?? {}) },
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
      child.once("error", (error) => finish({ ok: false, code: error.code ?? error.name ?? "spawn error" }));
      child.once("close", (code) => {
        if (!settled) finish({ ok: false, code: code === null ? "closed" : `exit ${code}` });
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id !== 1) continue;
          if (message.result?.serverInfo) finish({ ok: true, protocol: message.result.protocolVersion });
          else finish({ ok: false, code: "invalid initialize response" });
        }
      });
      child.stdin.end(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: CLI_NAME, version: "0.1.0" },
        },
      }) + "\n");
    } catch (error) {
      finish({ ok: false, code: error.code ?? error.name ?? "spawn error" });
    }
  });
}

async function cmdDoctor(argv, { collect = false } = {}) {
  const root = repoRoot();
  if (!collect && !currentStackScope()) {
    const catalog = stackCatalog(root);
    if (catalog.stacks.length || catalog.problems.length) {
      const rows = [];
      for (const row of catalog.stacks) {
        const environments = optionValue(argv, '--env') ? [optionValue(argv, '--env')]
          : Object.keys(row.document.environments);
        for (const environment of environments.length ? environments : [undefined]) {
          try {
            const scope = stackScope(root, { stack: row.name, environment });
            const report = await withStackScope(scope, () => cmdDoctor(argv.filter((value, i) =>
              value !== '--env' && argv[i - 1] !== '--env' && !value.startsWith('--env=')), { collect: true }));
            rows.push({ stack: row.name, environment: environment ?? null, ...report });
          } catch (error) { rows.push({ stack: row.name, environment: environment ?? null, ok: false, failed: 1,
            checks: [{ name: 'config', state: 'FAIL', detail: error.message, code: error.code }] }); }
        }
      }
      for (const problem of catalog.problems) rows.push({ ok: false, failed: 1,
        checks: [{ name: 'config', state: 'FAIL', detail: problem.message, code: problem.code }] });
      const failed = rows.reduce((n, row) => n + row.failed, 0), warns = rows.flatMap(row => row.checks).filter(row => row.state === 'WARN').length + catalog.notes.length;
      const report = { ok: failed === 0, stacks: rows, checks: catalog.notes.map(note => ({ name: 'stack-reserved', state: 'WARN', detail: note.message ?? String(note) })), failed };
      if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));
      else {
        for (const row of rows) {
          console.log(`${row.stack ?? 'catalog'} / ${row.environment ?? 'no environment'}`);
          for (const check of row.checks) console.log(`  ${check.state} ${check.name}: ${check.detail}`);
        }
        for (const check of report.checks) console.log(`  ${check.state} ${check.name}: ${check.detail}`);
        console.log(doctorSummaryLine(failed, warns));
      }
      process.exitCode = failed ? 1 : 0;
      return report;
    }
  }
  const selected = requestArgs(argv, "doctor", { booleans: ["--json", "--why", "--offline", "--repair"], values: ["--probe"] });
  argv = selected.args;
  const offline = argv.includes('--offline');
  const probeIndex = argv.indexOf("--probe");
  const probeOverride = probeIndex < 0 ? null : argv[probeIndex + 1];
  if (probeIndex >= 0 && (!probeOverride || probeOverride.startsWith("--") || argv.lastIndexOf("--probe") !== probeIndex))
    die("PROBE_URL_REQUIRED", "Provide exactly one URL with --probe.", `Use: ${CLI_NAME} doctor --probe <http(s)-url>`);
  // An explicit selector is an execution boundary and therefore fails closed.
  // Ordinary doctor, however, owns config diagnosis: a malformed file must be
  // one FAIL row in the complete report rather than a pre-report exception.
  const cfg = selected.environment !== undefined
    ? selectRequestConfig(root, selected.environment) : resolveConfig(root);
  // A selected URL is not an executed target until the client reaches fetch.
  // The built-in localhost fallback is never probed; fresh installs use a
  // disclosed public onboarding request outside the repository API contract.
  let configuredTarget = null;
  let apiProbe = null;
  let zenLine = null;
  const commandResolution = advertisementPlan(root);
  const checks = [];
  for (const note of stackCatalog(root).notes) if (!currentStackScope() || note.stack === currentStackScope().stack)
    checks.push({ name: 'stack-reserved', state: 'WARN', detail: note.message });
  const add = (name, state, detail, fix) => checks.push({ name, state, detail, ...(fix ? { fix } : {}) });
  const guide = inspectLayoutReadme(root);
  if (['unmanaged', 'invalid-markers'].includes(guide.status)) add('layout-readme', 'WARN',
    `${LAYOUT.readme} kept unchanged: ${guide.status === 'unmanaged' ? 'unrecognized unmarked guide' : 'incomplete or ambiguous generated markers'}.`,
    `Keep handwritten text outside one ${POINTER_BEGIN} / ${POINTER_END} pair; run ${CLI_NAME} connect to refresh only that pair.`);
  const legacy = legacyLayoutEntries(root);
  if (legacy.length) add("layout", "WARN",
    `Pre-layout files: ${legacy.map(row => row.from).join(", ")}`,
    `Move the existing install without overwriting conflicts: ${CLI_NAME} migrate`);
  else if (existsSync(join(root, LAYOUT.readme))) add("layout", "PASS", `Project files live under ${LAYOUT.directory}; see ${LAYOUT.readme}.`);
  else add("layout", "WARN", `No ${LAYOUT.readme} yet.`, `Create the project layout: ${CLI_NAME} start`);

  // 1. Installation health is independent of API coverage. A missing optional
  // contract is a warning for every repository shape, including monorepos and
  // providers. A broken selected/discovered input is still a real failure.
  const contractPath = findContract(root, cfg);
  // A fresh repository (no stack, no single-store files) creates a named stack
  // next. Advice about the single-store files leads to STACKS_MIGRATION_REQUIRED.
  const freshRepository = !currentStackScope() && !hasLegacyStack(root) && !stackCatalog(root).stacks.length;
  let primaryContractReadable = false;
  if (!contractPath) add("contract", "WARN", "no OpenAPI document selected or found; setup can continue",
    (freshRepository
      ? `Optional: bind one to a stack with ${CLI_NAME} stack add <name> --base-url <url> --contract <path>. `
      : `Optional: set API_CONTRACT to an existing spec for contract-based init/learn/verify. `) +
    `Use \`${CLI_NAME} map .\` to inspect API surfaces; this warning does not assess API coverage.`);
  else if (!existsSync(contractPath)) add("contract", "FAIL", "the selected OpenAPI contract is missing",
    `Restore its configured path or remove the stale contract selection, then run ${CLI_NAME} doctor.`);
  else {
    let contractProblem = null;
    try {
      // Do not attempt to read directories, devices or FIFOs as documents.
      if (!statSync(contractPath).isFile()) contractProblem = "the OpenAPI contract path is not a regular file";
      else {
        const { doc } = readContract(contractPath);
        const mapping = value => value !== null && typeof value === "object" && !Array.isArray(value);
        const version = mapping(doc) && (doc.openapi ?? doc.swagger);
        const knownVersion = typeof version === "string" &&
          (typeof doc.openapi === "string" ? /^3\.[01]\.\d+(?:[-+].*)?$/.test(version) : version === "2.0");
        const paths = mapping(doc?.paths);
        const nonPathDocument = typeof doc?.openapi === "string" && doc.openapi.startsWith("3.1.") &&
          doc.paths === undefined && (mapping(doc.webhooks) || mapping(doc.components));
        if (!knownVersion || (!paths && !nonPathDocument))
          contractProblem = "the file is not a readable OpenAPI 3.0/3.1 or Swagger 2.0 document with a paths mapping (or OpenAPI 3.1 webhooks/components)";
      }
    } catch { contractProblem = "the OpenAPI contract cannot be read or parsed"; }
    if (contractProblem) add("contract", "FAIL", contractProblem,
      "Check the selected path, file permissions and document format. Doctor does not perform full OpenAPI schema validation.");
    else {
      add("contract", "PASS", `readable ${contractPath.replace(root + "/", "")}; schema and API operations not verified`);
      primaryContractReadable = true;
    }
  }
  // Named contracts remain independently diagnosable even when the primary
  // API has no contract or its selected document cannot be read.
  const contractTargets = [...(primaryContractReadable
    ? [{ name: '', file: contractPath, baseUrl: cfg.baseUrl, pathPrefix: cfg.contractPathPrefix }] : []),
    ...Object.entries(cfg.hosts ?? {}).filter(([, host]) => host?.contract).map(([name, host]) =>
      ({ name: `:${terminalText(name)}`, file: host.contract, baseUrl: host.baseUrl, pathPrefix: host.contractPathPrefix }))];
  for (const target of contractTargets) {
    const diagnostics = [];
    const loaded = loadHttpContract(target.file, { pathPrefix: target.pathPrefix,
      onDiagnostic: item => diagnostics.push(item) });
    const skipped = diagnostics.filter(item => item.code === 'HTTP_CONTRACT_ROUTE_SKIPPED');
    const rejected = diagnostics.find(item => item.code === 'HTTP_CONTRACT_REJECTED');
    if (skipped.length) add(`contract-routes${target.name}`, loaded ? 'WARN' : 'FAIL',
      `${skipped.length} path keys (${skipped.reduce((sum, item) => sum + item.methods.length, 0)} operations) skipped: ` +
      skipped.map(item => `${item.path} (${item.methods.join(', ')}): ${item.reason}`).join('; '),
      'These keys are omitted from both contract inventory and runtime matching. Declare query parameters separately from path keys.');
    else if (rejected) add(`contract-routes${target.name}`, rejected.reason === 'no-matchable-routes' ? 'WARN' : 'FAIL',
      `HTTP contract rejected: ${rejected.reason}.`, 'Check the bound contract and contractPathPrefix.');
    if (loaded) {
      const mount = httpContractMountInfo(loaded, target.baseUrl);
      add(`contract-mount${target.name}`, 'PASS',
        `prefix ${terminalText(JSON.stringify(mount.pathPrefix))} from ${mount.source}; canonical contract operation identities are retained`);
    }
  }

  // 2. api-environments.json valid — a typo here mis-points everything after it.
  const problem = cfg.problems[0];
  if (problem) add("config", "FAIL", problem.message, problem.next);
  else if (!cfg.file && freshRepository) add("config", "WARN", "no API stack yet; notes and shared capture need one (a contract is optional)",
    `Name the first API you call: ${CLI_NAME} stack add <name> --base-url <url>`);
  else if (!cfg.file) add("config", "WARN", `no ${LAYOUT.environments}; using env vars + built-in defaults`,
    `Optional. Add ${LAYOUT.environments} to name environments and set project defaults (budget, timeout, evidence dir, stale-days).`);
  else add("config", "PASS", `valid — ${cfg.file.replace(root + "/", "")}${cfg.name ? `, environment '${cfg.name}'` : ""}`);

  // 3. Exercise the actual client. A default or explicit onboarding target
  // never becomes a configured repository API or a contract operation.
  if (problem)
    add("base-url", "WARN", "reachability not checked because the environment config is invalid", problem.next);
  else if (offline) add('base-url', 'WARN', 'API reachability not checked (--offline); no API requests were sent');
  else {
    const targetSource = probeOverride !== null ? "override" : cfg.baseUrlSource === "fallback" ? "default" : "configured";
    const targetUrl = probeOverride ?? (targetSource === "default" ? DEFAULT_DOCTOR_PROBE : cfg.baseUrl);
    const r = await reachable(targetUrl, { json: argv.includes("--json"), targetSource });
    zenLine = renderDoctorZen(r.body, { targetSource, method: r.method, url: targetUrl, status: r.status });
    apiProbe = { target_source: targetSource, attempts: r.attempts, authentication: "not_sent", assertions: "not_run",
      purpose: "onboarding", repo_contract: null,
      ...(r.evidence ? { evidence: r.evidence } : {}), ...(r.code ? { code: r.code } : {}),
      ...(r.ok ? { status: r.status, http_ok: r.http_ok, duration_ms: r.duration_ms, rate_limit_headers: r.rate_limit_headers } : {}) };
    if (r.attempts.length) configuredTarget = targetSource === "configured"
      ? { ...requestTarget(cfg), base_url: doctorTargetUrl(targetUrl) }
      : { environment: null, base_url: doctorTargetUrl(targetUrl), base_url_source: targetSource === "default" ? "onboarding-default" : "--probe" };
    if (r.ok) {
      add("base-url", r.http_ok ? "PASS" : "WARN", `${doctorTargetUrl(targetUrl)} reachable through the API client (HTTP ${r.status}, ${r.duration_ms} ms); API assertions and authentication were not verified`);
      if (!r.http_ok) add("probe-http", "WARN", `probe returned HTTP ${r.status}; the response was not successful and no retry or redirect was attempted`,
        `Inspect the saved observation, choose --probe <url>, or use --offline for local setup checks.`);
      const rate = Object.entries(r.rate_limit_headers ?? {});
      const rateText = rate.length ? rate.map(([key, value]) => `${key}: ${value}`).join(", ") : "response supplied no supported rate-limit headers; no quota assumed";
      // An unsuccessful probe that names an empty quota (or a 429) is a rate
      // limit on the probe target, not a setup failure; say so instead of PASS.
      const headers = r.rate_limit_headers ?? {};
      if (!r.http_ok && (headers["x-ratelimit-remaining"] === "0" || r.status === 429)) {
        const reset = /^\d{9,11}$/.test(headers["x-ratelimit-reset"] ?? "")
          ? new Date(Number(headers["x-ratelimit-reset"]) * 1000).toISOString().replace(/\.000Z$/, "Z") : null;
        add("probe-rate-limits", "WARN", `rate limit exhausted (HTTP ${r.status})${reset ? `; resets ${reset}` : ""}${rate.length ? `. ${rateText}` : ""}`,
          `This is the probe target's quota, not your setup. Run ${CLI_NAME} doctor --offline for the local checks, retry after the reset, or choose another target with --probe <url>.`);
      } else add("probe-rate-limits", "PASS", rateText);
      try {
        apiProbe.observation = { ...recordDoctorObservation(root, {
          purpose: "onboarding", observed_at: r.observed_at, target_source: targetSource,
          provider: new URL(targetUrl).origin, method: r.method, url: doctorTargetUrl(targetUrl),
          status: r.status, http_ok: r.http_ok, duration_ms: r.duration_ms,
          rate_limit_headers: r.rate_limit_headers, evidence_id: r.evidence,
          authentication: "not_sent", assertions: "not_run", repo_contract: null,
        }), retrieve: `${CLI_NAME} context query --onboarding` };
        add("onboarding", "PASS", `saved local observation ${r.evidence} in ${apiProbe.observation.path}; outside repository API contract knowledge`,
          `Read it without a request: ${apiProbe.observation.retrieve}`);
      } catch (error) {
        const code = error.code?.startsWith("ONBOARDING_") ? error.code : "ONBOARDING_OBSERVATION_WRITE_FAILED";
        apiProbe.observation = { state: "failed", code };
        add("onboarding", "FAIL", `HTTP response received, but the local onboarding observation was not saved: ${code}`,
          "Review local evidence directory permissions or damaged observation data. No request was repeated.");
      }
    } else add("base-url", "FAIL", `API client probe failed for ${doctorTargetUrl(targetUrl)}: ${r.code}`,
      `Review the named client failure and probe URL; no API assertions or authentication were verified.`);
  }

  // 4. Auth env var exists — configured but unset is the classic 401 mystery.
  const readiness = authReadiness(cfg.auth, credentialEnvironment(cfg.credentialEnvFiles));
  const { vars } = readiness;
  if (readiness.state === 'none') add("auth", "WARN", "no auth configured for this environment",
    "Fine if the API is open. Otherwise set API_AUTH (bearer:ENV, header:Name:ENV, query:param:ENV, basic:USER_ENV:PASS_ENV, or oauth:ID_ENV:SECRET_ENV) or the environment's auth field.");
  else if (readiness.state === 'invalid')
    add("auth", "FAIL", "auth spec is not a recognised form (value omitted)",
    "Use bearer:ENV_VAR, header:Name:ENV_VAR, query:param:ENV_VAR, basic:USER_ENV:PASS_ENV, or oauth:CLIENT_ID_ENV:CLIENT_SECRET_ENV.");
  else if (readiness.state === 'invalid_value')
    add('auth', 'FAIL', readiness.problem, 'Correct the referenced Basic credential values; UTF-8 is used. Authentication has not been verified.');
  else {
    const missing = readiness.missing ?? [];
    if (missing.length) add("auth", "FAIL", `auth references ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set`,
      `Export the credential: export ${missing[0]}=... (or place it in the environment's envFile).`);
    else add("auth", "PASS", `auth env var${vars.length === 1 ? "" : "s"} present: ${vars.join(", ")}; authentication is unverified`);
  }

  // 5. Registered as an MCP server — the check that answers "why does my agent
  //    not see the tool". A WARN, not a FAIL: the CLI is a complete product on
  //    its own and a repo may deliberately use only that. A registration whose
  //    server file has MOVED is a FAIL, because it is worse than none: the host
  //    reports a server that will not start and nothing says why.
  {
    const { mcpTargets, planTarget, projectEntry, projectPathProblem, planRuntimeRepair } =
      await import("../lib/connect.mjs");
    // The SAME composition connect writes; anything else and doctor reports
    // "registered with different settings" against a registration it approves of.
    const contractPlan = planSetupContract(root, cfg, { contextContract: loadContext(root)?.api?.contract });
    const entry = projectEntry(root, { ...cfg, contract: contractPlan.contract }, { configText: contractPlan.text });
    const rows = mcpTargets(root).map((target) => {
      const unsafe = projectPathProblem(root, target.file);
      if (unsafe) return { target, plan: { action: "conflict", registered: false,
        reason: `${unsafe}; project MCP paths must not traverse symbolic links.`,
        fix: `Replace the linked path with a real file/directory inside the project, then re-run ${CLI_NAME} connect.` } };
      const text = existsSync(target.file) ? readFileSync(target.file, "utf8") : null;
      return { target, text, plan: planTarget(text, target, entry) };
    });
    if (argv.includes('--repair')) {
      const repairs = rows.map(row => ({ ...row, repair: row.plan.action === 'conflict'
        ? { action: 'refused', reason: row.plan.reason }
        : planRuntimeRepair(row.text, row.target, entry) }));
      const changed = repairs.filter(row => row.repair.action === 'repair');
      const pointers = changed.length ? runtimePointerRepairs(root, entry.env.API_SETUP_BINDING) : [];
      const refused = repairs.filter(row => row.repair.action === 'refused')
        .map(row => `${rel(root, row.target.file)}: ${row.repair.reason}`);
      refused.push(...pointers.filter(row => row.action === 'refused').map(row => row.reason));
      for (const path of [...changed.map(row => row.target.file), ...pointers.filter(row => row.action === 'repair').map(row => row.path)]) {
        const problem = writableDestinationProblem(path);
        if (problem) refused.push(`${rel(root, path)}: ${problem}`);
      }
      if (refused.length) add('mcp-repair', 'FAIL',
        `No files changed: ${refused.join('; ')}`,
        `Review the named registration and re-run ${CLI_NAME} connect if you want to regenerate its settings.`);
      else {
        for (const row of changed) {
          writeFileSync(row.target.file, row.repair.text);
          rows.find(item => item.target === row.target).plan = planTarget(row.repair.text, row.target, entry);
        }
        for (const row of pointers) writeFileSync(row.path, row.text);
        add('mcp-repair', 'PASS', changed.length
          ? `Repaired MCP launch wiring in ${[...changed.map(row => rel(root, row.target.file)), ...pointers.filter(row => row.action === "repair").map(row => rel(root, row.path))].join(', ')}. Restart or reload the agent to load the new registration.`
          : 'No MCP launch repairs needed.');
      }
    }
    const conflict = rows.find(({ plan }) => plan.action === "conflict");
    const registeredNames = ({ target, plan }) => {
      const keys = plan.registeredKeys ?? (plan.registeredKey ? [plan.registeredKey]
        : discoverMcpRegistrations(root).filter(row => row.file === rel(root, target.file)
          && [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS].includes(row.key)).map(row => row.key));
      return `${target.label} as ${keys.map(key => `'${key}'`).join(' and ') || '(not registered)'}`;
    };
    const legacyRows = rows.filter(row => LEGACY_MCP_SERVER_KEYS.some(key =>
      (row.plan.registeredKeys ?? [row.plan.registeredKey]).includes(key)));
    // Discovery also covers a customized legacy entry whose plan is a conflict.
    const legacyKeys = [...new Set(discoverMcpRegistrations(root)
      .filter(row => LEGACY_MCP_SERVER_KEYS.includes(row.key)).map(row => row.key))];
    if (legacyRows.length || legacyKeys.length) add('mcp-legacy', 'WARN',
      `Legacy MCP server key still registered: ${legacyKeys.join(', ') || LEGACY_MCP_SERVER_KEYS.join(', ')}.`,
      `Run ${CLI_NAME} migrate --dry-run if the repo has pre-layout files, then ${CLI_NAME} connect. Customized registrations are preserved as named conflicts.`);
    const moved = rows.find(({ plan }) =>
      (plan.currentServerPath && !existsSync(plan.currentServerPath)) ||
      (plan.currentCommand && isAbsolute(plan.currentCommand) && !existsSync(plan.currentCommand)));
    const ready = rows.filter(({ plan }) => plan.action === "unchanged");
    if (conflict) add("mcp", "FAIL", conflict.plan.reason, conflict.plan.fix);
    else if (moved) {
      const missing = moved.plan.currentServerPath && !existsSync(moved.plan.currentServerPath)
        ? moved.plan.currentServerPath : moved.plan.currentCommand;
      add("mcp", "FAIL",
        `${registeredNames(moved)} in ${rel(root, moved.target.file)}, but ${missing} does not exist`,
        `Repair recognized Node or npm-cache launch paths with: ${CLI_NAME} doctor --offline --repair. Customized registrations are preserved for review.`);
    }
    else if (ready.length === rows.length) {
      const launches = new Map();
      const probes = await Promise.all(ready.map(({ plan }) => {
        const key = JSON.stringify(plan.entry);
        if (!launches.has(key)) launches.set(key, mcpReachable(plan.entry));
        return launches.get(key);
      }));
      const failed = probes.find((probe) => !probe.ok);
      if (!failed) add("mcp", "PASS",
        `registered for ${ready.map(registeredNames).join(" and ")}; ` +
        `MCP initialize responded (${probes.map((probe) => probe.protocol).join(", ")})`);
      else add("mcp", "FAIL",
        `registered for ${ready.map(registeredNames).join(" and ")}, ` +
        `but MCP reachability was not proven (${failed.code})`,
        `Re-run ${CLI_NAME} connect, then run ${CLI_NAME} doctor again.`);
    }
    else {
      const stale = rows.filter(({ plan }) => plan.registered && plan.action !== "unchanged");
      add("mcp", "WARN",
        ready.length
          ? `registered for ${ready.map(registeredNames).join(", ")}; missing or different in ${rows.filter(({ plan }) => plan.action !== "unchanged").map(({ target }) => rel(root, target.file)).join(", ")}`
          : stale.length
            ? `registered with different settings: ${stale.map(registeredNames).join(', ')}`
            : `not registered as an MCP server in ${rows.map(({ target }) => rel(root, target.file)).join(" or ")}`,
        `Wire it into Claude Code and Codex in one command: ${CLI_NAME} connect`);
    }
  }

  // 6. Host skills. Registration alone exposes a tool but does not teach either
  //    host when to use it or how to preserve learned context.
  {
    const { planSkills, missingSkills, planSkillRemoval } = await import("../lib/connect.mjs");
    const missingSources = missingSkills();
    if (missingSources.length) add("skills", "FAIL",
      `this installation is missing ${missingSources.length} packaged skill source${missingSources.length === 1 ? "" : "s"}`,
      `Reinstall ${CLI_NAME}; this copy is incomplete.`);
    else {
      const skillPlans = planSkills(root, { cliName: commandResolution.portable.available
        ? commandResolution.portable.command : null });
      const legacyNames = new Set(Object.values(LEGACY_SKILL_NAMES).flat());
      const legacySkills = planSkillRemoval(root).filter(row => legacyNames.has(row.name) && row.action !== "absent");
      const ready = skillPlans.filter((s) => s.action === "unchanged");
      const edited = skillPlans.filter((s) => s.action === "differs");
      const conflict = skillPlans.find((s) => s.action === "conflict");
      if (conflict) add("skills", "FAIL", conflict.reason, conflict.fix);
      else if (legacySkills.length) add("skills", "WARN", `Legacy skills: ${legacySkills.map(row => row.name).join(", ")}`, `Move recognized skills into the project layout: ${CLI_NAME} migrate`);
      else if (ready.length === skillPlans.length) add("skills", "PASS",
        `installed for Claude Code and Codex (${ready.length} files)`);
      else add("skills", "WARN",
        `${ready.length}/${skillPlans.length} host skill copies match${edited.length ? `; ${edited.length} edited ${edited.length === 1 ? "copy" : "copies"} preserved` : ""}`,
        `Install missing skills with ${CLI_NAME} connect${edited.length ? "; use --force-skills only to replace edited copies" : ""}`);
    }
  }

  // 7. Wired into AGENTS.md / CLAUDE.md — an opt-in, so unwired is a WARN with
  //    the exact command, never a hard failure that blocks a working setup.
  const pointerStates = inspectPointerFiles(root);
  const unsafePointer = pointerStates.find(row => row.problem);
  const canonicalReady = pointerStates.some(row => row.file === "AGENTS.md" && row.managed && !row.problem);
  const wired = pointerStates.filter(row => !row.problem && (row.managed || row.bridge && canonicalReady)).map(row => row.file);
  if (unsafePointer) add("wiring", "FAIL", `${unsafePointer.file}: ${unsafePointer.problem}`,
    "Repair the named instruction path; linked or malformed files are preserved.");
  else if (wired.length === POINTER_FILES.length) add("wiring", "PASS", `wired into ${wired.join(", ")}${pointerStates.some(row => row.bridge) ? " (CLAUDE imports AGENTS)" : ""}`);
  else add("wiring", "WARN",
    wired.length ? `wired into ${wired.join(", ")} only; missing ${POINTER_FILES.filter((n) => !wired.includes(n)).join(", ")}`
                 : `not wired into ${POINTER_FILES.join(", ")}`,
    `Wire it so agents load the API context automatically: ${CLI_NAME} connect (or ${CLI_NAME} learn --agents for the pointer block alone)`);

  // Ongoing truth check for AX-B's committed instructions. Missing is advice,
  // not broken runtime: MCP-only guidance remains useful and connect names the
  // same omission. Metadata only; never execute a shim or a startup shell.
  {
    const plan = commandResolution;
    if (plan.portable.available) add("advertised-commands", "PASS",
      plan.portable.source === 'npm-exact-version'
        ? `${plan.portable.command} is an exact-version npm invocation; npx may download the package`
        : `${plan.portable.command} is an executable repo-local command; committed guidance may advertise it`);
    else add("advertised-commands", "WARN",
      `${plan.portable.command} is omitted from committed guidance because ${plan.portable.reason}`,
      plan.portable.remedy);
  }

  // 8. The cross-repo registry — the machine-level wiring that answers "why
  //    does my agent not get the billing repo's gotchas here". Severity follows
  //    the rules the checks above already set: absent optional machinery is a
  //    calm WARN (the config check's treatment of a missing file), a registry
  //    that EXISTS but cannot be read is FAIL carrying the loader's own message
  //    and next step (the config check's treatment of a broken file — every
  //    grant on this machine is invisible until it parses, and "cannot know"
  //    must never render as "nothing wrong"), and a grant pointing at something
  //    no longer readable is FAIL with the exact remedy (the mcp check's
  //    treatment of a registration whose server file moved: worse than none,
  //    because it claims a delivery that silently is not happening).
  {
    const { registry, path, exists, problem } = loadRegistry();
    // A location the environment chose must SAY so — the base-url check's
    // honesty rule again: a green line against a home the user never picked (a
    // fleet container's isolation override, a leaked harness variable) would
    // read identically to their real one, and a passing check about the wrong
    // place is worse than none.
    const where = process.env[HOME_ENV_NAME] ? `${path} (from ${HOME_ENV_NAME})` : path;
    if (problem) add("registry", "FAIL", `${problem.message}${process.env[HOME_ENV_NAME] ? ` (location from ${HOME_ENV_NAME})` : ""}`, problem.next);
    else if (!exists)
      // The state of every machine before the first grant: one line, nothing
      // graded, and no follow-on rows — registration and grants cannot exist
      // without the file, so reporting on them would be noise about nothing.
      add("registry", "WARN", `no machine registry at ${where} — every repo is an island until the first grant`,
        `Optional. \`${CLI_NAME} grant <repo>\` lets this repo read that repo's ${contextFile()} (registering both sides); \`${CLI_NAME} connect\` registers without granting anything.`);
    else {
      const repoCount = Object.keys(registry.repos).length;
      add("registry", "PASS",
        `${repoCount} repo${repoCount === 1 ? "" : "s"}, ${registry.grants.length} grant${registry.grants.length === 1 ? "" : "s"} — ${where}`);
      const me = resolveRef(registry, root);
      if (!me?.id)
        // Not a failure: this is every repo before connect or its first grant.
        // Both registering commands are named because they register DIFFERENT
        // amounts — connect is inert, grant also opens a read.
        add("grants", "WARN", "this repo is not in the machine registry, so no grant can name it",
          `Register it: \`${CLI_NAME} connect\` (registers, grants nothing), or \`${CLI_NAME} grant <repo>\` (registers both sides and opens the read in one step).`);
      else {
        // The consumer seat: every granted provider must still be READABLE —
        // root on disk, knowledge file present, knowledge file parseable —
        // because the client skips a dead one silently by design (a request
        // must never break on registry damage), which makes doctor the one
        // place the silence gets a voice. Each dead grant is its own row with
        // its own remedy: the fixes genuinely differ, and one mushed line
        // saying "2 grants are broken somehow" fixes nothing.
        const mine = registry.grants.filter((g) => g.consumer === me.id)
          .map((g) => {
            const provider = registry.repos[g.provider];
            return provider ? { id: g.provider, ...provider } : { id: g.provider, dangling: true };
          });
        const healthy = [];
        for (const p of mine) {
          if (p.dangling)
            add("grants", "FAIL", `grant references unregistered provider id '${p.id}' (dangling grant)`,
              `Re-register the provider if it should exist, or remove this grant from ${path}`);
          else if (!existsSync(p.root))
            add("grants", "FAIL", `granted provider '${p.name}' is dead wiring: ${p.root} no longer exists`,
              `Restore ${p.root}, or drop the dead grant: ${CLI_NAME} revoke ${p.name}`);
          else if (!existsSync(join(p.root, contextFile(p.root))))
            add("grants", "FAIL", `granted provider '${p.name}' has no ${contextFile()} in ${p.root}`,
              `Create it: run \`${CLI_NAME} init\` in that repo, or drop the grant: ${CLI_NAME} revoke ${p.name}`);
          else {
            const context = inspectContext(p.root);
            if (context.state === "malformed")
              add("grants", "FAIL", `granted provider '${p.name}' has a ${contextFile()} that does not parse (${context.path})`,
                `Fix the JSON, or drop the grant: ${CLI_NAME} revoke ${p.name}`);
            else if (context.state === "unusable")
              add("grants", "FAIL", `granted provider '${p.name}' has a ${contextFile()} with an unusable shape (expected an object with an operations map)`,
                `Regenerate it with \`${CLI_NAME} init\`, or drop the grant: ${CLI_NAME} revoke ${p.name}`);
            else healthy.push(p.name);
          }
        }
        if (healthy.length) add("grants", "PASS", `may read ${healthy.join(", ")}`);
        else if (!mine.length) add("grants", "PASS",
          `no cross-repo grants — this repo reads only its own ${contextFile()} (default deny)`);
        // The provider seat: awareness only, deliberately ungraded — who may
        // read this repo is a fact the owner should see in the report, but
        // whether those consumers are healthy is THEIR doctor's business.
        const readers = registry.grants.filter((g) => g.provider === me.id)
          .map((g) => registry.repos[g.consumer]?.name ?? g.consumer);
        add("readers", "PASS", readers.length
          ? `${readers.join(", ")} may read this repo's ${contextFile()}`
          : "no repo may read this one (grants are directional and default-deny)");
      }
    }
  }

  // 9. Command-name hygiene. This is intentionally best-effort and therefore
  // never a FAIL: PATH contents and exported-function metadata can explain a
  // surprising shell invocation, but their absence cannot prove an interactive
  // shell has no alias. Inspect metadata only; never execute a candidate or a
  // startup shell while diagnosing the user's shell.
  {
    const { inspectDoctorEnvironment } = await import("../lib/doctor-path.mjs");
    const shell = inspectDoctorEnvironment({ cwd: root });
    if (shell.legacy.length) {
      const found = shell.legacy.map(({ name, count }) =>
        `'${name}' (${count} distinct executable${count === 1 ? "" : "s"})`).join(", ");
      add("path-binaries", "WARN", `declared legacy command on PATH: ${found}`,
        `Remove the legacy launcher, or ensure ${CLI_NAME} is the command your shell resolves first.`);
    } else add("path-binaries", "PASS", "no declared legacy command is executable on PATH");

    if (shell.exportedFunction)
      add("shell-shadow", "WARN", `an exported shell function named '${PRODUCT}' can shadow the executable`,
        `Remove the exported function before running ${CLI_NAME}. ` +
        "Aliases and non-exported functions are not inspected because doctor never executes shell startup files.");
    else add("shell-shadow", "PASS",
      "no environment-visible exported function shadows this command; aliases and non-exported functions are not inspected because doctor never executes shell startup files");
  }

  // Inspect raw arrays and relationships before any learner can normalize
  // them. Legacy history is usable with unknown integrity, never silently
  // adopted as a reviewed baseline by diagnosis or an unrelated request.
  const noteContext = inspectContext(root);
  if (["malformed", "unusable"].includes(noteContext.state))
    add("note-history", "FAIL", "The knowledge file is unreadable or has an unusable shape.", "Preserve the file and repair its JSON/operations structure; doctor does not rewrite history.");
  else if (noteContext.state === "healthy") {
    const histories = noteEntries(loadContext(root)).map(({ key, entry }) => ({ ...inspectNoteHistory(entry, noteKeyLabel(key)), key }));
    const problematic = histories.filter(history => history.issues.length);
    if (!problematic.length) add("note-history", "PASS", `${histories.length} note histories have valid structure and recorded or empty baselines.`);
    for (const history of problematic) {
      const failedHistory = history.state === "invalid";
      const recovery = history.key.kind === "stack" ? `${CLI_NAME} show --stack ${currentStackScope()?.stack ?? "<name>"} --human --history; review --stack ${currentStackScope()?.stack ?? "<name>"} --scope stack --accept-notes --if-notes <digest>` : null;
      add("note-history", failedHistory ? "FAIL" : "WARN",
        `${history.operation}: ${history.state}; ${[...new Set(history.issues.map(issue => `${issue.code}: ${issue.message}`))].slice(0, 8).join("; ")}`,
        recovery ?? (failedHistory ? `Read ${CLI_NAME} show "<operation>" --human --history; preserve original records and repair malformed structure explicitly.`
          : `Review ${CLI_NAME} show "<operation>" --human --history, then acknowledge its current digest with review --accept-notes "<operation>" --if-notes <digest>.`));
    }
  }

  // R11 adds its source diagnostic after the established setup/registry checks.
  const { inspectLegacyState } = await import('../lib/machine-state.mjs');
  const oldState = inspectLegacyState({ reportOnce: true });
  const stateSources = entries => entries.length ? entries.map(path => terminalText(path)).join(', ') : 'none';
  add('legacy-state', oldState.reported.length ? 'WARN' : 'PASS',
    (oldState.reported.length ? `Files left untouched in ${terminalText(oldState.directory)}: ${oldState.reported.map(name => terminalText(name)).join(', ')}. ` : '') +
    `Usage read sources: ${stateSources(oldState.reads.usage)}. Readable token caches (current first, legacy fallback): ${stateSources(oldState.reads.tokens)}. No files are moved.`,
    ...(oldState.reported.length ? ['Review these local files yourself; both locations remain available in place.'] : []));

  const failed = checks.filter((c) => c.state === "FAIL").length;

  const report = { ok: failed === 0,
      ...(configuredTarget ? { request_target: configuredTarget } : {}),
      ...(apiProbe ? { api_probe: apiProbe } : {}), checks, failed };
  if (collect) return report;
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 1));
    process.exit(failed ? 1 : 0);
  }

  console.log(`${CLI_NAME} doctor — ${root}${configuredTarget ? `\n  ${apiProbe.target_source === "configured" ? requestTargetLine({ ...cfg, baseUrl: configuredTarget.base_url }) : `onboarding ${apiProbe.target_source}: ${configuredTarget.base_url}`}` : ""}\n`);
  for (const c of checks) {
    console.log(`  ${c.state.padEnd(4)} ${c.name.padEnd(9)} ${c.detail}`);
    if (c.fix) console.log(`       fix: ${c.fix}`);
  }
  const warns = checks.filter((c) => c.state === "WARN").length;
  if (zenLine) console.log(zenLine);
  console.log(`\n${doctorSummaryLine(failed, warns)}`);
  process.exit(failed ? 1 : 0);
}

// --- receipt ---------------------------------------------------------------
// F6c: the agent will not advocate for the tool, so the tool emits its own
// value — from the usage log the client wrote, never from estimates (the
// arithmetic and the honesty rules live in lib/receipt.mjs).
// A receipt reads both current and legacy usage logs in place;
// it does not import the API client or send requests.

async function cmdReceipt(argv) {
  const { readUsageSources } = await import("../lib/feedback.mjs");
  const { parseSince, buildReceipt, renderReceipt, scopeToProject } = await import("../lib/receipt.mjs");

  const sinceIdx = argv.indexOf("--since");
  let sinceMs = null;
  if (sinceIdx !== -1) {
    sinceMs = parseSince(argv[sinceIdx + 1]);
    // A wrong window silently widened to the whole log would misreport the
    // value — the receipt's one sin — so an unparseable spec is a hard error.
    if (sinceMs == null) {
      console.error(`usage: ${CLI_NAME} receipt [--since 24h|7d|2026-08-01] [--json]`);
      process.exit(1);
    }
  }

  // No log is the day-zero state, and a boring truthful answer, not an error.
  const root = repoRoot();
  const { rows: allRows, logs } = readUsageSources();
  // USAGE_LOG is machine-wide; a receipt read standing in ONE repo means that
  // repo, not everything else tested on the same machine (2026-08-23 — an
  // alpha feedback report otherwise claimed 1,339 calls for a two-route repo).
  const rows = scopeToProject(allRows, root);
  const ctx = loadContext(root);   // display text only; every count is from the log
  const receipt = buildReceipt(rows, ctx, { sinceMs, logs, ...(logs.length === 1 ? { log: logs[0].path } : {}) });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...receipt, scope: { project: basename(root), rows_this_project: rows.length, rows_total_machine: allRows.length } }, null, 1));
    return;
  }
  console.log(renderReceipt(receipt));
  if (allRows.length > rows.length)
    console.log(`\n(scoped to this repo: ${rows.length} of ${allRows.length} calls machine-wide. ` +
      `Full cross-project picture: ${CLI_NAME} request --report.)`);
}

// --- feedback --------------------------------------------------------------
// Collection remains local. Only explicit --send enters the separately gated
// API-client path; the human confirms every send unless they chose allow.
//
// It runs with execution OFF. Feedback is a reporting act, and a report that
// fires HTTP at whatever happens to be configured is a surprise nobody asked
// for on a machine we do not own.

async function cmdFeedback(argv) {
  const root = repoRoot();
  const selected = requestArgs(argv, "feedback", {
    booleans: ["--anonymize", "--execute", "--json", "--send", "--confirm-send"],
    values: ["--out", "--agent-note", "--score", "--host-agent", "--answers"],
    equals: ["--out", "--agent-note", "--score", "--host-agent", "--answers"], redactedUnknown: true,
  });
  argv = selected.args;
  const execute = argv.includes("--execute");
  const surfaces = findSurfaces(root);
  const surfaceConfigs = preflightSurfaceEnvironment(surfaces, selected.environment);
  const selectedTargets = configuredSurfaceTargets(surfaces, surfaceConfigs);
  const cfg = surfaceConfigs[0]?.cfg ?? (selected.environment !== undefined
    ? selectRequestConfig(root, selected.environment) : resolveConfig(root));
  const { buildFeedback, renderFeedback, readUsageSources, readFeedbackContexts, wiredHosts, feedbackFilename } =
    await import("../lib/feedback.mjs");
  const { buildReceipt, scopeToProject } = await import("../lib/receipt.mjs");

  const send = argv.includes('--send');
  if (!send && (argv.includes('--confirm-send') || ['--agent-note', '--score', '--host-agent', '--answers'].some(key => optionValue(argv, key) !== undefined)))
    die('FEEDBACK_SEND_REQUIRED', 'Send options require --send. A local report needs no send options.');
  const anonymize = send || argv.includes("--anonymize");
  // Off by default: a feedback command that fires HTTP at whatever happens to
  // be configured is a surprise on a machine we do not own. Opt in, and the
  // report says plainly which way it ran.

  // A tree with no API surface is a legitimate thing to send feedback about
  // ("I pointed it at my repo and got nothing"), so an empty model is a
  // result, not an error.
  let map = null;
  let feedbackAttempted = 0, feedbackResponses = 0;
  let feedbackTargetFields = selectedTargets.length
    ? selectedRequestTargetFields(selectedTargets)
    : selectedRequestTargetFields(usableRequestConfig(cfg)
      ? [{ service: basename(root), ...requestTarget(cfg) }] : []);
  try {
    if (surfaces.length) {
      const results = [];
      for (const s of surfaces) results.push(await auditSurface(s, { execute }));
      const { edges, external } = deriveEdges(results);
      map = footprintModel({ root, surfaces: results, edges, external,
        platform: platformConsistency(results, edges) });
      feedbackAttempted = results.reduce((sum, row) => sum + (row.attempted ?? 0), 0);
      feedbackResponses = results.reduce((sum, row) => sum + (row.checked ?? 0), 0);
      if (execute) feedbackTargetFields = requestEvidenceFields(results, selectedTargets);
    } else {
      map = footprintModel({ root, surfaces: [], edges: [],
        external: upstreamUrls(root, null).map((u) => ({ from: u.file, url: u.url, via: u.file })),
        platform: [] });
    }
  } catch (e) {
    // A crash here is itself worth reporting, and losing the whole report to
    // it would be the worst possible outcome of asking someone for feedback.
    map = { services: [], summary: {}, crashed: String(e?.message ?? e) };
  }

  // USAGE_LOG is machine-wide (client.mjs) so it can answer cross-project
  // questions via the request command's --report; a feedback report is about ONE
  // repo, and without scoping it silently claims every other project tested
  // on the same machine (found 2026-08-23: a two-route repo's report showed
  // 1,339 calls and 92 gotchas reused — impossible to reconcile, correctly
  // flagged as unreportable by the alpha tester who ran it).
  // Reading the usage receipt is static reporting and must not import the
  // request client (whose module initialization resolves a base URL). Honor
  // the same optional override directly; no argument retains feedback.mjs's
  // lazy machine-state resolver.
  const { rows: allUsage, logs } = readUsageSources();
  const usage = scopeToProject(allUsage, root);
  const { ctx, contexts, evidence_classes } = readFeedbackContexts(root);
  let receipt = null;
  try { receipt = buildReceipt(usage, ctx); } catch { /* optional */ }

  const model = buildFeedback({ map, ctx, contexts, evidence_classes, receipt, usage, wired: wiredHosts(root), anonymize,
    executed: feedbackResponses > 0, attempted: feedbackAttempted, executionRequested: execute,
    env: feedbackTargetFields,
    machineWideCalls: allUsage.length, usageSources: logs });
  if (argv.includes("--json") && !send) { console.log(JSON.stringify(model, null, 2)); return; }

  const feedbackOut = flagValue(argv, "--out");
  if (!feedbackOut) ensureLayout(root);
  const out = safeOutputPath(feedbackOut ? resolve(feedbackOut) : resolve(root, feedbackFilename(root)));
  writeOutputFile(out, renderFeedback(model, { cli: CLI_NAME }), { mode: 0o600 });

  if (send) {
    const { buildFeedbackPayload } = await import('../lib/feedback-payload.mjs');
    let answers = {};
    const answersFile = optionValue(argv, '--answers');
    if (answersFile !== undefined) {
      try {
        const text = readFileSync(answersFile, 'utf8');
        if (Buffer.byteLength(text) > 32768) throw new Error();
        answers = JSON.parse(text);
      } catch { die('FEEDBACK_ANSWERS_INVALID', 'The answers file must contain a bounded JSON object. No file contents were sent.'); }
    }
    const score = optionValue(argv, '--score');
    const payload = buildFeedbackPayload(model, {
      agentNote: optionValue(argv, '--agent-note') ?? '', ...(score !== undefined ? { score: Number(score) } : {}),
      hostAgent: optionValue(argv, '--host-agent') ?? 'other', answers, version: packageVersion(), forbiddenNames: [basename(root)],
    });
    const { apiRequest } = await import('../lib/client.mjs');
    const result = await apiRequest({ stack: FEEDBACK_STACK_NAME, method: 'POST', path: '/feedback', body: payload, expect: [{ status: 202 }] },
      { initiator: 'cli.feedback', feedback: { confirmed: argv.includes('--confirm-send') } });
    if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(`Feedback accepted: ${result.data.id}\nLocal receipt: ${result.feedback_receipt}\nPrivate evidence: ${result.evidence.path}`);
    else console.error(JSON.stringify({ error: result.error, ...(result.rate_limit ? { rate_limit: result.rate_limit } : {}),
      ...(result.feedback_receipt ? { receipt: result.feedback_receipt } : {}), ...(result.evidence ? { evidence: result.evidence } : {}) }, null, 2));
    if (!result.ok) process.exitCode = result.mode === 'refused' ? 2 : 1;
    return;
  }

  console.log(`wrote ${out}`);
  console.log(`  Nothing was sent. Read it, answer the three questions at the bottom,`);
  console.log(`  and send the file to whoever gave you this build.`);
  if (!anonymize && model.what_it_found.services > 0)
    console.log(`  Service names are included — re-run with --anonymize to replace them.`);
}

// --- help & exit codes -----------------------------------------------------
// One table drives both the top-level listing and every per-command --help, so
// the example a stranger copies is the same string the tool documents. Each
// entry: a one-line blurb and a RUNNABLE example. Exit codes are documented in
// exactly one place (EXIT_CODES) and reprinted under every --help, because a
// script that branches on them needs the contract stated, not inferred.

const EXIT_CODES = `Exit codes (note/history policy contract; request JSON errors and unsupported Node versions also use 2):
  0   success — the operation ran and nothing failed
  1   failure — an error, a failed check, or detected drift (doctor/verify/audit --ci)
  2   refused — a write was blocked because it would have committed a secret
  3   policy refused — a non-secret note or history policy blocked the operation`;

const HELP = {
  workbench: { blurb: 'open this repository’s local workbench; inspect, send, save and hand back changes', example: `${CLI_NAME} workbench` },
  saved: { blurb: 'create, discover and run portable requests with local typed inputs', example: `${CLI_NAME} saved list` },
  migrate: { blurb: 'move legacy knowledge, environments and evidence into named API stacks',
             example: `${CLI_NAME} migrate --dry-run --json` },
  audit:   { blurb: "survey every API under a tree: operations, owners, disagreements",
             example: `${CLI_NAME} audit . --ci` },
  map:     { blurb: "render the footprint — services, edges, ownership, shadow routes — as one self-contained HTML file",
             example: `${CLI_NAME} map . --out api-footprint.html` },
  graph:   { blurb: "export portable API context, query dependencies, and inspect potential change impact",
             example: `${CLI_NAME} graph context --json` },
  survey:  { blurb: 'explicitly generate, check, query or render a portable API relationship snapshot; no requests',
             example: `${CLI_NAME} survey generate` },
  view:    { blurb: "write one static snapshot of stored API knowledge, reports and repo receipts; no requests or server",
             example: `${CLI_NAME} view` },
  sessions: { blurb: "per session, what the client did: calls, assertions, notes delivered and written, drift, drafts, refusals and leftovers — from local files, no requests",
             example: `${CLI_NAME} sessions --since 7d` },
  connect: { blurb: "wire this into your coding agent in one command: MCP registration, skills, pointer block, first API stack",
             example: `${CLI_NAME} connect --base-url https://api.example.com` },
  repos:   { blurb: "the machine registry: every connected repo, and who may read whom",
             example: `${CLI_NAME} repos --json` },
  grant:   { blurb: `let this repo read another repo's ${contextFile()} — directional, default-deny, read fresh at query time`,
             example: `${CLI_NAME} grant ../billing-api` },
  revoke:  { blurb: "withdraw a grant; dead on the very next query, no daemon to lag behind",
             example: `${CLI_NAME} revoke billing-api` },
  stack: { blurb: 'add an API stack or move an operation into its chosen stack', example: `${CLI_NAME} stack add billing --base-url https://billing.example.test --auth bearer:BILLING_KEY` },
  stacks: { blurb: 'list stack environments, contract state and knowledge counts', example: `${CLI_NAME} stacks --json` },
  init:    { blurb: `inventory the contract into ${contextFile()} (no execution)`,
             example: `${CLI_NAME} init` },
  learn:   { blurb: "execute safe reads (GET/HEAD only), record what is true, and name skipped operations; --ci deposits from a pipeline, no agent in the loop",
             example: `${CLI_NAME} learn --env local --agents` },
  doctor:  { blurb: "check setup health (also: status, check, health, ping): contract, config, base URL, auth, wiring",
             example: `${CLI_NAME} doctor` },
  capabilities: { blurb: "inventory security-relevant filesystem and network capability classes",
             example: `${CLI_NAME} capabilities --json` },
  show:    { blurb: "one operation's observed responses and separate legacy verification; --env selects scope",
             example: `${CLI_NAME} show "GET /orders" --env local --human` },
  note:    { blurb: "record an authored API claim; preserve older claims when correcting guidance",
             example: `${CLI_NAME} note "GET /orders" "cursor is opaque; do not decode it"` },
  verdict: { blurb: "record a decision NOT to use an API, with its reason, class, and probe",
             example: `${CLI_NAME} verdict "POST /refunds" --verdict rejected --reason "no idempotency key" --class structural` },
  import:  { blurb: "Postman v2/v3, Insomnia v4, or Bruno → runnable suite + honest loss report (secrets omitted by design, every item classified)",
             example: `${CLI_NAME} import collection.json --values postman-env.json` },
  postman: { blurb: "capture a scrubbed Postman estate into the sibling corpus (GET-only, budgeted, values never written)",
             example: `${CLI_NAME} postman capture --out ../postman-corpus` },
  request: { blurb: "execute one HTTP request with bounded evidence and named failures",
             example: `${CLI_NAME} request GET /health` },
  protocol: { blurb: "execute a bounded GraphQL, JSON-RPC, gRPC, WebSocket or HTTP request from JSON",
             example: `${CLI_NAME} protocol request.json --env local` },
  context: { blurb: "capture or retrieve scoped API observations, or explicitly bind legacy operation context",
             example: `${CLI_NAME} context query query.json` },
  suite:   { blurb: "save and run named, re-runnable request suites",
             example: `${CLI_NAME} suite run smoke` },
  verify:  { blurb: "run saved suites as conformance probes; report what no longer holds as drift",
             example: `${CLI_NAME} verify --read-only --ci` },
  receipt: { blurb: "what this window delivered: envelope-vs-raw-response tokens, gotchas reused, drift surfaced — counted from the usage log; not session cost or savings",
             example: `${CLI_NAME} receipt --since 24h` },
  feedback: { blurb: "write a local feedback report; --send uses ask/allow/never policy, --confirm-send records the human's yes for this session",
             example: `${CLI_NAME} feedback --anonymize` },
  review:  { blurb: "review explicit note identities, acknowledge history, or list curation candidates",
             example: `${CLI_NAME} review --drop "GET /legacy"` },
  prune:   { blurb: "batch-drop named curation candidates (explicit)",
             example: `${CLI_NAME} prune "GET /legacy" "GET /old" --dry-run` },
  unwire:  { blurb: "undo connect: remove its registrations, skills, pointer block, and exact generated CI artifacts",
             example: `${CLI_NAME} unwire` },
  start:   { blurb: "set up your coding agent, inventory local APIs without requests, and prepare the next task",
             example: `${CLI_NAME} start` },
  mcp:     { blurb: "enumerate MCP declarations by default; tool calls require per-tool opt-in and a read-only claim or unsafe override",
             example: `${CLI_NAME} mcp inspect node server.mjs` },
};

const layoutHelp = `Project layout (generated from the naming seam):
  ${LAYOUT.readme} — start here; committed guide
  ${LAYOUT.collection}/<name>/ — stack.json, contract and knowledge
  ${LAYOUT.directory}/defaults.json — repository defaults
  ${LAYOUT.collection}/ — repository suites, audit baseline and graph artifacts
  ${LAYOUT.evidence}/ — local captures, ignored by ${LAYOUT.gitignore}
  ${LAYOUT.skills}/ — canonical skills copied to host locations
  Existing single-store installs: ${CLI_NAME} migrate --dry-run`;

function printTopHelp() {
  const lines = [`${CLI_NAME} — shared API knowledge for coding agents`, ""];
  const width = Math.max(...Object.keys(HELP).map((k) => k.length));
  for (const [name, h] of Object.entries(HELP)) {
    lines.push(`  ${name.padEnd(width)}  ${h.blurb}`);
    lines.push(`  ${" ".repeat(width)}  EXAMPLE: ${h.example}`);
  }
  lines.push("", "Request commands accept --env <name>; it outranks API_ENV and the configured default. Legacy layout only: API_BASE_URL overrides the selected environment's URL and is reported explicitly. Explicit stacks use their configured environment URLs; API_BASE_URL does not override them.",
    "Run `" + CLI_NAME + " <command> --help` for one command's detail.", "", layoutHelp, "", EXIT_CODES);
  console.log(lines.join("\n"));
}

function printCommandHelp(name) {
  const h = HELP[name];
  if (!h) { printTopHelp(); return; }
  let detail = name === "note"
    ? `\n\nUsage:\n  ${CLI_NAME} note "<METHOD /path>" "<one sentence>" [--alongside | --supersedes sha256:<full-note-digest>] [--evidence run-<id>] [--json]\n\n--json sends refusals to stdout as JSON; successful receipts are always JSON. Secret refusals exit 2; non-secret note-history policies exit 3; usage and other errors exit 1. The first note needs no relationship flag. If authored or unattributed active notes exist, choose alongside or supersession explicitly. Supersession preserves the original text and provenance. The receipt lists exactly the replacement record's evidence, including an empty list; old evidence is not inherited. Exact active duplicates and replacement retries are idempotent and retain the saved evidence; requested_evidence_warnings describes newly supplied references that were not attached. --evidence is repeatable (up to 16); references retain local evidence digest, producer and scope metadata, never request/response bodies. A missing run is marked unavailable; a different scope is marked mismatched. Neither verifies the explanation. Existing managed pointer blocks refresh separately after saving; repeat the same command if refresh fails.\n\nExisting unbaselined or changed histories need explicit reviewed acceptance: review --accept-notes "<operation>" --if-notes <digest from show>. Never edit knowledge JSON by hand. Docs: docs/note-history.md`
    : name === "show"
    ? `\n\nOptions:\n  --env <name>              select the primary provider environment (also --env=<name>)\n  --human                  readable observed responses, active notes and full identities\n  --history                include superseded history in the human view\n  --json                   default: preserve raw arrays and add active_notes/note_history\n\nObserved is not verified. The selected provider, environment and live contract must match, and retained complete responses need matching local evidence. Other scoped history stays labelled separately; legacy_confidence preserves the older learning grade. Reads send no requests. Superseded claims remain saved; changed or malformed history stays visible with named integrity issues. No explanatory claim is verified by a saved evidence link.\nDocs: docs/protocols.md`
    : name === "review"
    ? `\n\nReviewed note-history acknowledgement:\n  ${CLI_NAME} review --accept-notes "<operation>" --if-notes sha256:<current-history-digest>\n\nInspect the complete history first with show --human --history. Acceptance records who, when and the prior baseline; prior integrity may remain unknown. It cannot recover deleted content or validate an explanation. --drop and prune refuse to erase authored or unattributed history. --dry-run previews without writing.`
    : name === "migrate"
    ? `\n\n${layoutHelp}\n\nAlways run --dry-run first and inspect the plan. Options: --json, --dry-run, --name <stack>, repeated --split <environment>=<stack>. Splits are suggested but never applied without --split. Contract-declared operations go to their API stack; ambiguous or undeclared operations go to unsorted. Files are written and read back before sources are removed. Migration executes no requests. Afterwards run ${CLI_NAME} connect.\n\nRe-file an operation without changing its notes:\n  ${CLI_NAME} stack move --to <stack> "<METHOD /path>" [--from <stack>]\n\nOld single-store requests and reads still work; capture and notes require this migration. The implicit read path and migrate command sunset in 0.2.`
    : name === "start"
    ? `\n\nOptions:\n  --json                   machine-readable setup status, inventory, and continuation prompt\n  --dry-run                preview wiring without writing files or running requests\n  --contract <path>        use an existing OpenAPI contract and retain it for later tasks\n\nSetup installs project MCP wiring, skills, and AGENTS.md/CLAUDE.md guidance. It sends no API requests, enables no hooks or CI, and can be repeated. The coding agent must confirm its own tool availability; if unavailable, restart or reopen it and say \"Finish ${PRODUCT} setup\".`
    : name === "doctor"
    ? `\n\nOptions:\n  --offline                check local setup and MCP initialize without API requests\n  --probe <url>            override the target with one announced unauthenticated GET\n  --repair                 repair recognized Node and npm-cache launches in otherwise matching generated MCP wiring; preserve conflicts\n  --json                   machine-readable PASS/WARN/FAIL rows\n\nWithout --offline, the API client announces GET https://api.github.com/zen on a fresh install, or an unauthenticated HEAD to the configured base URL (one announced GET only if HEAD transport fails). --probe overrides either target with one GET. No redirects, retries or OAuth grants. Status, latency and safe rate-limit headers are retained locally as onboarding evidence, outside repository API contract knowledge. Read them with context query --onboarding (add --human for a terminal summary). HTTP reachability does not verify API assertions or authentication. MCP initialize proves a new process can start; an existing agent session still needs restart/reload.`
    : name === "request"
    ? `\n\nUsage:\n  ${CLI_NAME} request <METHOD> <path> [body-json|-] [fields|-] [idempotency-key]\n  ${CLI_NAME} request <METHOD> <path> --body <json>\n\nOptions:\n  --body <json>            send one JSON body (also --body=<json>); choose this or a positional body, never both\n  --expect-status <100-599>  assert one HTTP response status (also --expect-status=200)\n\nNo assertion is assumed without this option. For richer assertions, use request envelope with an explicit v2 expect array; envelopes declare their own body.\nOn a fresh project with no API configuration, GET https://api.github.com/zen is the built-in onboarding example. It announces the request, sends no credentials, follows no redirects and makes no retries. Its local evidence is separate from shared repository API context. Other URLs require a configured provider.`
    : name === "protocol"
    ? `\n\nUsage:\n  ${CLI_NAME} protocol <request.json> [--env <name>]\n\nThe input is one request, or an envelope whose requests each name a protocol.\nProtocols: http, graphql, jsonrpc, grpc, websocket. GraphQL subscriptions select graphql-transport-ws automatically.\nOutput is JSON; failures, partial results and incomplete captures exit nonzero. Requests use configured targets and authentication.\nDocs: docs/protocols.md`
    : name === "context"
    ? `\n\nRead saved onboarding evidence without requests:\n  ${CLI_NAME} context query --onboarding [--human]\nThe default is JSON; --human prints a historical terminal summary, not a new doctor run.\nSubcommands:\n  ${CLI_NAME} context capture <input.json>    record an external observation or author claim\n  ${CLI_NAME} context query <query.json>      read matching local and granted-provider context\n  ${CLI_NAME} context migrate <input.json>    explicitly bind legacy HTTP operation identities\n  ${CLI_NAME} context keys [--dry-run] [--json]  link path and query keys to the earlier response fields that supplied them, from local evidence (names only)\n\nThese commands execute no API requests. Capture retains bounded structure, evidence identities and provenance. External claims do not become client verification.\nDocs: docs/protocols.md`
    : name === "show"
    ? `\n\nStack discovery:\n  ${CLI_NAME} show --stack <name> [--human] [--history]\nLists the selected stack's saved inventory, active notes and bounded scoped observations; omissions are named. JSON is the default. Observed responses remain separate from execution verification. Add an operation for full detail: ${CLI_NAME} show --stack <name> "GET /path". This command sends no API requests.`
    : name === "graph"
    ? `\n\nGraph commands:\n  export [repo] [--manifest <path>] [--out <path>] [--allow-outside-project] [--json]\n  context [repo#node] [--catalog <path>] [--operation <identity>] [--environment <name>] [--max-bytes <n>] [--include-foreign-claims] [--json]\n  impact <repo#node> [--catalog <path>] [--environment <name>] [--max-bytes <n>] [--include-foreign-claims] [--json]\n  record --observation-id <id> --note <lesson> [--operation-id <digest>] [--json]\n  record <repo#node> --operation <identity> --note <lesson> [--environment <name>] [--protocol <name>] [--json]\n  stats [--json]\n\nConfigure ${LAYOUT.graphManifest} in the repository. Exports reuse saved context; queries read selected Git/CI snapshot files. No API requests, cloning or remote publication.\nDocs: docs/dependency-graph.md`
    : name === "suite"
    ? `\n\nSubcommands:\n  ${CLI_NAME} suite save <name> [file.json]   save a suite from a file or stdin\n  ${CLI_NAME} suite run [name] [--json]        run one suite, or all of them\n  ${CLI_NAME} suite list                       show saved suites and step counts`
    : name === "sessions"
      ? `\n\nOptions:\n  --since <window|date>     only calls at or after 90m, 24h, 7d, 2w or an ISO date; totals are recomputed\n  --stack <name>            only calls routed to one stack\n  --json                    print the ledger model (names, counts, statuses, codes and ids; no values)\n  --out <file.html>         also write the offline HTML section the view page carries\n  --allow-outside-project    explicitly allow an --out destination outside the project\n\nOne session is one host process (an MCP server or one CLI invocation). Older evidence without a process id is grouped by build, host and local day, and says so. See docs/sessions.md.`
    : name === "view"
      ? `\n\nOptions:\n  --out <path>              HTML destination (default: <evidence dir>/view/index.html)\n  --allow-outside-project    explicitly allow an external output destination\n  --open                    hand the completed file to the OS opener (never default)\n  --json                    print path, generated_at, head, snapshot and opened as JSON\n\nNo API requests by default. --execute announces a bounded GET/HEAD plan before sending through the client; --no-execute keeps the local-only view. No scripts or external resources in the page. Missing historical reports are named.\nDocs: docs/view.md`
    : name === "map"
      ? `\n\nNetwork:\n  --execute                announce and execute declared GET/HEAD reads through the API client\n  --no-execute             force the default local-only projection\n\nShared context:\n  --catalog <path>          include a selected Git/CI graph snapshot catalog\n\nBrowser preview:\n  --preview                start a loopback browser preview (opt-in)\n  --no-preview             prevent preview startup, including with --preview\n  --allow-outside-project  allow --out beyond the project boundary\n\nWith --preview, HTML output includes a browser URL, worker pid and stop command.\nThe preview expires after 30 minutes. The saved HTML works offline.\nWithout --preview, no listener starts. --json and --text never start a preview.\n\nReconciliation:  ${CLI_NAME} map reconcile [repo] [--suite <name>] [--json|--gfm]\n  joins imported suite identities to measured ${contextFile()} operations; it never executes requests`
    : name === "audit"
      ? `\n\nCI options:\n  --ci                 diff findings against the reviewed baseline; exit 1 on new drift\n  --report-only        with --ci, print the same drift and exit 0 for findings\n  --summary <path>     with --ci, append a safe GitHub-flavored markdown summary\n  --no-execute         static audit and freshness only; send no API requests\n  --baseline           locally regenerate the accepted state for review`
    : name === "connect"
      ? `\n\nFirst API stack (only when the repository has none):\n  an OpenAPI contract, when found, becomes the first stack, as before\n  --base-url <url>     otherwise create it for this API; same checks as stack add (no credentials, query or fragment)\n  --stack <name>       name it (default: derived from the contract title or the host, api.stripe.com -> stripe)\n  --auth <scheme:VAR>  a credential reference by environment-variable name; never a value\n  --env <name>         its environment name (default: default)\n  with no flag, the one public API the code calls is chosen (source detected-in-code); several or none create\n  nothing and print stack add commands. Loopback and private hosts are listed, never chosen.\n  Until a stack exists, nothing your agent calls is kept. A second connect never adds a stack.\n\nOptional alpha feedback, interception and CI:\n  --alpha              compatibility alias; the feedback skill is installed by default\n  --claude-hook        explicitly merge a Claude Code PreToolUse hook that blocks curl/wget to configured repo APIs\n  --ci                 explicitly write .github/workflows/${CI_WORKFLOW_BASENAME}\n  --install <mode>     vendored: offline ${LAYOUT.ciTarball}; registry: exact generating CLI version\n  --switch-install     explicitly change an intact owned CI install to the selected mode\n  --dry-run            name optional hook/CI artifacts without writing them\n\nCodex hook: unsupported (no reliable project PreToolUse surface); MCP, skills, and pointer guidance remain.`
    : name === "unwire"
      ? `\n\nOptional CI cleanup:\n  removes an exact generated workflow and its digest-bound tarball when present; edited, foreign, linked, or ambiguous artifacts stay`
    : name === "learn"
      ? "\n\nOutput details:\n  --limit=N             cap safe reads (equals form only)\n  withheld_fields counts fields whose observed values were withheld at the promotion boundary; field names and cardinality remain available."
      : name === "postman"
        ? `\n\nCapture: ${CLI_NAME} postman capture [--out ../postman-corpus] [--budget N] — requires POSTMAN_API_KEY from .env; only GET calls are emitted.`
      : "";
  if (new Set(["learn", "audit", "map", "doctor", "request", "protocol", "suite", "verify", "feedback"]).has(name))
    detail += `\n\nRequest environment:\n  --env <name>          select a named config environment (also --env=<name>); outranks API_ENV/default\n  API_BASE_URL          legacy layout only: overrides the selected environment's URL; output labels the override\n  Explicit stacks       use their configured environment URLs; API_BASE_URL does not override them`;
  if (["stack", "stacks", "init", "note", "show", "learn", "context", "request"].includes(name)) detail += `\n\nStack selection:\n  --stack <name>        choose one API stack; --env selects an environment within it\n  See docs/stacks.md for routing, isolation and legacy compatibility.`;
  if (name === "note") detail += `\n\nStack facts:\n  ${CLI_NAME} note --stack <name> --scope stack "<lesson>" [--operations "GET /path" "POST /path"] [--evidence run-<id>]\nThe same relationship flags and history apply. Without --operations the fact applies throughout that stack. Five facts precede operation notes; omitted facts name show --stack <name>.`;
  if (name === "note") detail += `\n\nDraft acceptance:\n  ${CLI_NAME} note --stack <name> [--env <name>] --accept-draft <id> ["<edited wording>"] [--alongside | --supersedes <note-id>]\nDrafts are local suggestions bound to their original stack, environment, contract and evidence. They never write knowledge automatically; acceptance uses the normal secret, history and relationship rules.`;
  if (name === "note") detail += `\n\nAccount facts:\n  ${CLI_NAME} note --stack <name> --env <name> --scope account "<fact>" [--evidence run-<id>] [--shared]\nPrivate and local by default, scoped to the configured credential reference. --shared explicitly saves the fact and reference in committed knowledge. Credential fingerprints stay private. Rotation marks existing facts as changed until you explicitly repeat or correct each fact; reads never confirm them. Existing history and relationship flags apply. This records an authored claim, not an API verification.`;
  if (name === "show") detail += `\n\nAccount facts:\n  ${CLI_NAME} show --stack <name> --env <name> --scope account [--human] [--history]\nReads only facts for that environment's current credential reference. Changed, missing and unconfirmed credentials are named. No requests are sent; private account facts are excluded from ordinary shared views.`;
  if (name === "review") detail += `\n\nStack history: review --stack <name> --scope stack --accept-notes --if-notes <digest from show --stack <name>>`;
  if (name === 'review') detail += `\n\nPer-note decisions:\n  ${CLI_NAME} review "METHOD /path" --note sha256:<full-note-digest> --decision trusted|disputed|run-requested --by NAME --actor person|agent [--limits TEXT] [--reason TEXT] [--evidence run-ID] [--stack NAME] --json\nRepeat --note for an explicit batch, and --evidence for multiple run IDs. Disputes and run requests require a reason. Batch trust holds back authored-replaced notes and names their replacements. Latest decision wins; history is retained and exact retries are idempotent. Overturning trusted guidance takes a run for both people and agents. Agent self-trust needs new locally available covering evidence. Actor/by are caller-selected attribution, not authenticated identity. Text is data, never execution authority. A run request also writes one handoff with the verify prompt to the repository run-request inbox, for an agent to find with api_workbench status, read and ack; an exact retry adds none and nothing executes. If the inbox write fails, the decision stays saved and the receipt's handoff names the code. Show displays the latest review label, with a run request's status: open, acknowledged or run attached. Stable refusal codes and MCP equivalents: docs/note-history.md.`;
  if (name === 'note') detail += `\n\nBasis on new provenance:\n  --basis KIND [--source REF]\nKinds: ${NOTE_BASIS_KINDS.join(', ')}. Source is a run ID, repository-relative contract/source file and optional digest, or documentation URL without query values. Sources are data and are never fetched. Existing provenance is immutable; duplicate retries report the original basis. Legacy opening-word inference appears only on reads, explicitly marked inferred. --actor imported attributes import/summary tools separately from people and agents.\n` ;
  if (name === 'note') detail += `\n\nRetirement:\n  ${CLI_NAME} note "METHOD /path" "REASON TEXT" --retires sha256:<full-note-digest> --reason false|removed|replaced-by-version|no-longer-applies|other [--actor person|agent] [--by NAME] [--evidence run-ID] [--stack NAME] --json\nAppends a retirement note naming the original identity and a replacement link with a separate reason-class record. Original text and provenance remain in history. Trusted guidance requires an attached run, including ordinary supersession. Actor defaults to agent; by uses the local note author marker. Both are attribution, not authentication. Operation notes also accept --by and --actor when first authored. Never select notes by array position. Docs: docs/note-history.md.`;
  if (name === "context") detail += `\n\nA query JSON may contain search (case-insensitive text) and operation to filter selected stack facts. Retrieval stays local and returns an omission count plus show command.`;
  if (name === "stack") detail += `\n\nRe-file an operation without deleting its note history:\n  ${CLI_NAME} stack move --to <stack> "<METHOD /path>" [--from <stack>] [--json]`;
  if (name === 'feedback') detail += `\n\nOptional send:\n  --send                  prepare a scanned, anonymized payload and private receipt, then apply feedback.send\n  --confirm-send          attest the human said yes to this report in the current session\n  --agent-note <text>      optional plain-text feedback, at most 4,000 characters\n  --answers <json-file>    cry_wolf, new_to_you and first_ten_minutes answers\n  --score <1-10>          optional integer score\n  --host-agent <name>      claude-code, codex or other\n  --json                  return the safe client result for a send, or the local report without --send\n\nAsk is the default; explicit allow discloses before sending. The never setting refuses every send. Repository API environment selection applies to collection only, never the feedback destination. See docs/feedback.md.`;
  if (name === 'survey') detail += `\n\nUsage:\n  ${CLI_NAME} survey generate [--exclude-env] [--include-fixtures] [--out <json>]\n  ${CLI_NAME} survey status [--file <json>]\n  ${CLI_NAME} survey query --operation "<METHOD /path>" [--stack <name>] [--max-bytes 8192]\n  ${CLI_NAME} survey render --format json|dot|html [--file <json>] [--out <file>]\n\n--state-dir selects private change-detection state. Writes outside the project require --allow-outside-project. Query/render never scan or regenerate; status checks explicitly without rewriting the snapshot. No requests, application starts or credential resolution. Missing snapshots name generate; invalid snapshots produce a diagnostic. See docs/survey.md for provenance, scope and limitations.`;
  if (["start", "connect"].includes(name)) detail += `\n\n${layoutHelp}`;
  console.log(`${CLI_NAME} ${name} — ${h.blurb}\n\n  EXAMPLE: ${h.example}${detail}\n\n${EXIT_CODES}`);
}

// --- entry -----------------------------------------------------------------

const argv = process.argv.slice(2);
const requestedCommand = argv[0];
const doctorAliases = new Set(["status", "check", "health", "ping"]);
const command = doctorAliases.has(requestedCommand) ? "doctor" : requestedCommand;

// stderr preserves doctor's stdout byte-for-byte — especially its JSON — while
// making the guessed verb's redirection explicit rather than silently behaving
// like some unrelated command.
if (doctorAliases.has(requestedCommand))
  console.error(`${CLI_NAME} ${requestedCommand} redirects to ${CLI_NAME} doctor`);

if (command === "--version" || command === "-v") { printVersion(); process.exit(0); }

// --help / -h is universal and is a SUCCESS, never an error. Bare `--help` (or
// `help`) prints the top-level listing; `<command> --help` prints that one
// command's detail. Intercepted before dispatch so no handler has to know about
// it and so an incomplete command with --help never trips its own usage error.
if (command === "--help" || command === "-h" || command === "help") { printTopHelp(); process.exit(0); }
if (command && (argv.includes("--help") || argv.includes("-h"))) {
  if (command === 'workbench') console.log((await import('../lib/workbench-cli.mjs')).workbenchHelp() + '\n\n' + EXIT_CODES);
  else if (command === 'saved') console.log((await import('../lib/saved-request-cli.mjs')).savedRequestHelp() + '\n\n' + EXIT_CODES);
  else printCommandHelp(command);
  process.exit(0);
}

async function dispatch() {
if (command === 'workbench') {
  const { runWorkbenchCli } = await import('../lib/workbench-cli.mjs');
  await runWorkbenchCli(repoRoot(), argv.slice(1)); return;
}
if (command === 'saved') {
  const { runSavedRequestCli } = await import('../lib/saved-request-cli.mjs');
  await runSavedRequestCli(repoRoot(), argv.slice(1)); return;
}
if (!command && !existsSync(join(repoRoot(), contextFile()))) printCommandHelp("start");
else if (command === "stack") {
  if (argv[1] === "move") await cmdStackMove(argv);
  else cmdStack(argv);
}
else if (command === "stacks") cmdStacks(argv);
else if (command === "init") cmdInit(argv);
else if (command === "connect") await cmdConnect(argv);
else if (command === "migrate") await cmdMigrate(argv);
else if (command === "repos") cmdRepos(argv);
else if (command === "grant") cmdGrant(argv);
else if (command === "revoke") cmdRevoke(argv);
else if (command === "capabilities") await cmdCapabilities(argv);
else if (command === "learn") await cmdLearn(argv);
else if (command === "doctor") await cmdDoctor(argv);
else if (command === "audit") await cmdAudit(argv);
else if (command === "view") await withCodeLocations(repoRoot(), () => cmdView(argv));
else if (command === "sessions") await cmdSessions(argv);
else if (command === "map") {
  if (argv[1] === "reconcile") await cmdMapReconcile(argv);
  else await withCodeLocations(repoRoot(), () => cmdMap(argv), { includeFixtures: argv.includes("--include-fixtures") });
}
else if (command === "start") await cmdStart(argv);
else if (command === "mcp") await cmdMcp(argv);
else if (command === "show") await withCodeLocations(repoRoot(), () => cmdShow(argv));
else if (command === 'survey') {
  const { runSurveyCommand } = await import('../lib/survey-cli.mjs');
  const result = await runSurveyCommand(repoRoot(), argv.slice(1));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
else if (command === "note") cmdNote(argv);
else if (command === "verdict") cmdVerdict(argv);
else if (command === "request" && argv.length === 2 && argv[1] === "--report") {
  // Static machine accounting has no request target or environment to select.
  process.argv = [process.argv[0], process.argv[1], '--report'];
  await import("./request.mjs");
}
else if (command === "request") {
  const { args, environment } = requestArgs(argv.slice(1), "request", {
    values: ["--body", "--expect-status", "--stack"], equals: ["--body", "--expect-status", "--stack"],
    dashValues: ["--body"], redactedUnknown: true,
  });
  if (!stackCatalog(repoRoot()).stacks.length && !isBuiltinStack(optionValue(args, '--stack')) && !isBuiltinFeedbackTarget(args[1])) selectRequestConfig(repoRoot(), environment);
  if (args.length < 2) die("REQUEST_ARGUMENTS_REQUIRED", "Provide an HTTP method and path.", `${CLI_NAME} request GET /health`);
  process.argv = [process.argv[0], process.argv[1], ...args, ...(environment ? ["--env", environment] : [])];
  await import("./request.mjs");
}
else if (command === "protocol") await cmdProtocol(argv);
else if (command === "context") cmdContext(argv);
else if (command === "graph") await cmdGraph(argv);
else if (command === "suite") await cmdSuite(argv);
else if (command === "import") await cmdImport(argv);
else if (command === "postman") await cmdPostman(argv);
else if (command === "verify") await cmdVerify(argv);
else if (command === "receipt") await cmdReceipt(argv);
else if (command === "feedback") await cmdFeedback(argv);
else if (command === "review") cmdReview(argv);
else if (command === "prune") cmdPrune(argv);
else if (command === "unwire" || command === "disconnect") await cmdUnwire(argv);
else {
  // A bare invocation prints help and SUCCEEDS (0); an unknown command prints
  // help but is a usage error (non-zero), so a typo is caught by a script.
  printTopHelp();
  process.exit(command ? 1 : 0);
}

}
const optionalScopedCommands = new Set(['suite', 'verify', 'protocol', 'audit']);
const scopedCommands = new Set(['note', 'show', 'learn', 'context', 'verdict', 'review', 'prune', 'init', 'start', 'connect', 'doctor']);
try {
  let scope;
  if ((scopedCommands.has(command) || optionalScopedCommands.has(command) && optionValue(argv, '--stack'))
      && (stackCatalog(repoRoot()).stacks.length || isBuiltinStack(optionValue(argv, '--stack')))) {
    const stack = optionValue(argv, '--stack'), environment = optionValue(argv, '--env');
    // Doctor diagnoses the complete catalog when no stack was selected.
    const repoOnboarding = command === 'context' && argv[1] === 'query' && argv[2] === '--onboarding' && !stack;
    if (!repoOnboarding && (command !== 'doctor' || stack) && (command !== 'connect' || stack || stackCatalog(repoRoot()).stacks.length === 1 || stackCatalog(repoRoot()).defaults.default_stack)) scope = stackScope(repoRoot(), { stack, environment });
    for (let i = argv.length - 1; i >= 0; i--) {
      if (argv[i].startsWith('--stack=')) argv.splice(i, 1);
      else if (argv[i] === '--stack') argv.splice(i, 2);
    }
  }
  if (scope?.readOnly) {
    if (!['show', 'context', 'doctor', 'protocol', 'suite', 'verify', 'audit'].includes(command)
        || command === 'context' && argv[1] !== 'query') assertWritableStack(scope);
    // Diagnostics must never turn the existence of a built-in stack into an
    // automatic request to the feedback service.
    if (['doctor', 'audit'].includes(command) && !argv.includes('--offline'))
      die('FEEDBACK_REQUEST_EXPLICIT', 'The packaged feedback stack does not run automatic probes. Use doctor --offline or make an explicit declared request.');
  }
  await (scope ? withStackScope(scope, dispatch) : dispatch());
} catch (error) { die(error.code ?? 'STACK_OPERATION_FAILED', error.message, error.next); }
