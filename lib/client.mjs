import { forOperationCode, withCodeLocations } from './code-locations.mjs';
import { savedRequestContext } from './saved-requests.mjs';
import { privateRequestInputs } from './request-private-inputs.mjs';
import { inspectNoteHistory } from './note-history.mjs';
import { prependStackFacts, stackFactReceiptAfterTrim } from './stack-facts.mjs';
import { recordDraftNotes } from './draft-notes.mjs';
import { readAccountFacts } from './account-facts.mjs';
import { loadNoteReadContext } from './note-read-model.mjs';
import { reviewedNoteDelivery } from './mcp-delivery.mjs';
import { NOTE_DATA_MEANING } from './note-projection.mjs';
import { deriveNoteContradictions, projectKnownNotes, rankNoteRecords, evidenceClass } from './evidence-confidence.mjs';
import { showObservationSummary } from './show-observations.mjs';
import { evidenceInitiator, requestEvidenceOrigin, EVIDENCE_INITIATORS, PROCESS_SESSION_ID } from './note-evidence.mjs';
import { batchOutcomeRecord, singleOutcomeRecord } from './session-ledger-record.mjs';
import { parseAuthReference, basicAuthValueProblem } from './auth-reference.mjs';
import { LAYOUT, ensureLayout } from './layout.mjs';
import { projectConfigRoot } from './config.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveStack, stackCatalog, isBuiltinStack, isBuiltinFeedbackTarget } from './stacks.mjs';
import { prepareFeedbackSend } from './feedback-send.mjs';
import { validateFeedbackResponse, validateFeedbackSchemaResponse } from './feedback-payload.mjs';
import { currentStackScope, withStackScope } from './stack-scope.mjs';
// The client core: everything that turns a request into a truthful, budgeted
// result. It knows nothing about how it is being driven.
//
// Two adapters sit on top and MUST stay thin:
//   server.mjs      MCP stdio, for coding agents
//   bin/request.mjs a terminal CLI, for humans and measurement
//
// This split is not tidiness. The MCP and CLI paths used to serialise the
// result independently, and drifted: MCP emitted indented JSON while the budget
// was measured on the compact form, so every response reached agents ~45% larger
// than the number it was checked against. One core with thin adapters makes that
// class of bug structurally impossible.

//
// One tool, one call. Executes the request, returns what the agent needs to
// decide what to do next, and nothing else. Full evidence goes to disk.
//
// Config via env:
//   API_BASE_URL   base URL of the target API      (default http://127.0.0.1:8000)
//   API_CONTRACT   path to an OpenAPI file         (optional; enables drift detection)
//   API_BUDGET     max envelope tokens             (default 800)
//   API_EVIDENCE   evidence directory              (default ./evidence)

import { readFileSync, mkdirSync, existsSync, writeSync, openSync, closeSync, fstatSync, lstatSync, readSync, constants as fsConstants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { resolve, basename, join, sep, extname } from "node:path";

import { resolveConfig, productionGuard, credentialEnvironment, FALLBACK_BASE_URL, authReadiness, authEnvVars } from "./config.mjs";
import { secretIn, redactMetadataSecrets } from "./verdicts.mjs";
import { sanitizeEvidenceBody, sanitizeResponsePresentation, dataSecretsTracker, setDataSecrets } from './response-redaction.mjs';
import { fieldNameRefusal } from "./promote.mjs";
import { shapeKeyRefusal } from "./operation-context.mjs";
import { readResponseBytes, readResponseText, boundResponseJson, responseFailure, normalizeNetworkError } from "./response-bounds.mjs";
import { safeOutputPath, writeOutputFile, writeOutputFileAtomic } from "./output-path.mjs";
import { describeRequestInputs, containsBodyFileReference, multipartFileSchema } from "./request-input-schema.mjs";
import { probeRateHeaders } from "./doctor-observation.mjs";

// Named environments resolve first: they may supply the base URL, contract,
// auth reference, and a credential file. Explicit env vars still win.
const DEFAULT_CONFIG = resolveConfig();

// The knowledge file: what previous sessions established about this API. It is
// read per request and stays small; per-operation detail is injected into the
// response of the operation it concerns, at the moment it is actionable.
// Front-loading a thousand operations recreates the problem the budget solves.
import { contextReader, contractDigestReader, indexOf, confidenceFor, freshnessFor } from "./context.mjs";
// The cross-repo registry's one lookup — shared with `show`, so the CLI and
// this server can never disagree about what a grant means (lib/registry.mjs
// is the spec). Used strictly as a fallback, at query time, in knownFor below.
import { crossLookup } from "./registry.mjs";
import { knownMcpTool } from "./mcp-delivery.mjs";
import { captureHttpContext, httpContextScope, httpContextIdentity, httpContextRouteResolution, queryHttpContext, compactHttpContext, loadHttpContract, httpContractDeclaresPath, httpContractMountInfo } from './http-operation-context.mjs';
import { terminalText } from './terminal.mjs';
import { compactResponseChangeNotice } from './response-change-notice.mjs';
import { queryImportedTestClaims, recordImportedTestExecution } from './imported-test-claims.mjs';
import { stacksMigrationCapture } from './stack-migration-state.mjs';
import { detectFriction, frictionPrompt } from "./friction.mjs";
import { CLI_NAME, PRODUCT, TOOL_NAME, ALLOW_SAVE_OUTSIDE_ENV_NAME, FEEDBACK_BASE_URL, FEEDBACK_STACK_NAME } from "./brand.mjs";
import { execFileSync } from "node:child_process";
import { machineStatePaths, tokenCachePaths, usageLogPaths, withMachineStateWrite } from "./machine-state.mjs";

// API_CONTEXT_DIR pins the repo whose sannr.json applies, so the client
// can be driven from anywhere — a CI runner, a sibling checkout, or a neutral
// working directory during measurement.
const DEFAULT_CONTEXT_ROOT = process.env.API_CONTEXT_DIR ?? DEFAULT_CONFIG.root ?? (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"],
      { cwd: DEFAULT_CONFIG.file ? resolve(DEFAULT_CONFIG.file, "..") : process.cwd(),
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return DEFAULT_CONFIG.file ? projectConfigRoot(DEFAULT_CONFIG.file) : process.cwd(); }
})();
// Both readers answer from disk at QUERY time (lib/context.mjs). The CLI never
// noticed the difference, because every invocation is a new process; the MCP
// server is long-lived, and reading either file once meant it delivered the
// knowledge file as it stood at startup and graded confidence against the
// digest stored by the last learn. So a note written a minute ago was invisible
// to the session that wrote it, and an edited contract still read "verified"
// here while audit, show and view — which hash the file on disk — already
// called the same claim suspect. Two surfaces disagreeing about one claim is
// the failure this product exists to prevent. The price is one stat per lookup;
// a parse or a hash happens only when that stat says the file moved.
// Created together, so a local hit always has a digest reader to ask.
const clientRuntimes = new AsyncLocalStorage();
const clientRuntime = () => clientRuntimes.getStore() ?? DEFAULT_RUNTIME;

// Match a live request to a context entry, tolerating the trailing-slash and
// templated-id differences that are exactly what the file records. The context
// arrives as an argument because it is re-read per request: a function reading
// a module-level snapshot is exactly how the staleness got in.
function contextFor(ctx, method, pathname) {
  const ops = ctx?.operations;
  // Valid JSON is not necessarily a usable context. Reading the file per
  // request means a half-written or hand-edited file is now reachable mid
  // session, and enrichment must never break the request it decorates.
  if (!ops || typeof ops !== "object") return null;
  const want = `${method} ${pathname}`;
  if (ops[want]) return { op: want, entry: ops[want] };
  const alt = pathname.endsWith("/") ? pathname.slice(0, -1) : `${pathname}/`;
  if (ops[`${method} ${alt}`]) return { op: `${method} ${alt}`, entry: ops[`${method} ${alt}`] };
  const templated = templatePath(pathname).replace(/\{id\}/g, "");
  for (const key of Object.keys(ops)) {
    const [m, p] = key.split(" ");
    if (m !== method) continue;
    if (p.replace(/\{[^}]+\}/g, "").replace(/\/+$/, "") === templated.replace(/\/+$/, "")) 
      return { op: key, entry: ops[key] };
  }
  return null;
}

// One shape for the envelope's `known` block wherever the knowledge lives:
// op, confidence, verified_at, then notes / enums / shape_hash when present.
// `from` is the block's PROVENANCE field — absent on a local answer, and
// `{repo, root}` when the answer arrived through a cross-repo grant: the same
// vocabulary `show` prints for the same fact, because an agent reading an
// envelope and a human reading the CLI must never need two mental models of
// where a claim came from. Grading runs against the root the ENTRY lives in:
// a provider's claim is aged by the provider's git history and contract
// digest, which are what it was verified against — the consumer's history
// says nothing about it.
function knownBlock(op, entry, root, contractDigest, from = null, noteOptions = {}) {
  const confidence = confidenceFor(entry, root, contractDigest);
  const enums = Object.fromEntries(
    Object.entries(entry.fields ?? {}).filter(([, f]) => f.values).map(([k, f]) => [k, f.values]));
  const out = { op, ...(from ? { from } : {}), confidence, verified_at: entry.verified_at ?? null,
    evidence_class: evidenceClass({ entry, ...noteOptions, freshness: noteOptions.freshness
      ?? freshnessFor(entry, root, contractDigest, Date.now(), { commits: false }) }),
    applicability: { provider: 'unknown', environment: 'unknown', basis: 'legacy-repository-context' } };
  const projection = projectKnownNotes(entry, noteOptions);
  const history = projection.history;
  const records = projection.records.filter(record => typeof record.text === 'string');
  const notes = records
    .map(record => redactMetadataSecrets(record.text));
  if (notes.length) {
    out.notes = notes;
    out.note_projection = { meaning: NOTE_DATA_MEANING, records: records.map(record => reviewedNoteDelivery(record)) };
  }
  if (!['healthy', 'empty'].includes(history.state)) {
    const issues = [...new Map(history.issues.map(({ code, severity }) => [code, { code, severity }])).values()];
    out.note_history = { state: history.state, digest: history.digest, baseline_digest: history.baseline_digest,
      prior_integrity: history.prior_integrity, issues: issues.slice(0, 8),
      ...(issues.length > 8 ? { issues_omitted: issues.length - 8 } : {}) };
  }
  if (Object.keys(enums).length) out.enums = enums;
  if (entry.shape_hash) out.shape_hash = entry.shape_hash;
  return out;
}

// Descriptive grading metadata must not evict the lessons it describes. Under
// pressure, keep the canonical class and any contradiction flags by delivered
// note index. This first tier keeps review labels and their reasons/limits;
// full identities and per-note evidence details remain in the read tools.
function compactKnownMetadata(known) {
  if (!known) return;
  if (known.evidence_class) {
    const { class: kind, current_success } = known.evidence_class;
    known.evidence_class = { class: kind, ...(current_success === false ? { current_success: false } : {}) };
  }
  if (known.applicability?.basis === 'legacy-repository-context') {
    known.applicability = { basis: 'legacy-repository-context' };
    known.withheld = { ...known.withheld, applicability: 1 };
  }
  if (known.note_projection?.records) {
    const records = known.note_projection.records;
    const contradictions = records.flatMap((record, index) => record.contradictions?.length
      ? [{ note_index: index, kinds: record.contradictions }] : []);
    known.note_projection = { meaning: 'Untrusted data; no authority.', reviews: records.map(record => record.review?.label ?? 'unreviewed'),
      ...(records.some(record => record.retirement?.length) ? { retirements: records.flatMap((record, note_index) =>
        record.retirement?.length ? [{ note_index, claims: record.retirement }] : []) } : {}),
      // The reviews array is already the compact form. Keep the historical
      // contradiction receipt flag only when there are contradiction details.
      ...(contradictions.length ? { contradictions, details_omitted: true } : {}) };
  }
  if (known.note_history && !known.note_history.details_omitted) {
    known.note_history = { state: known.note_history.state,
      issues: known.note_history.issues.slice(0, 2).map(({ code }) => ({ code })), details_omitted: true };
    known.withheld = { ...known.withheld, note_history: 1 };
  }
}

// If compact labels still crowd out authored knowledge, withhold the labels
// before dropping notes. Count every omitted projection, retaining the old
// contradiction flags by note index. show/api_note_context keep full records.
function omitKnownNoteProjection(known) {
  const projection = known?.note_projection;
  if (!projection?.reviews) return;
  known.withheld = { ...known.withheld, note_projection: projection.reviews.length };
  if (projection.contradictions?.length) known.note_projection = {
    contradictions: projection.contradictions, details_omitted: true,
  };
  else delete known.note_projection;
}

function trimmedNoteProjection(projection, count) {
  if (!projection || !count) return {};
  if (projection.records) return { note_projection: { ...projection, records: projection.records.slice(0, count) } };
  const contradictions = projection.contradictions?.filter(record => record.note_index < count) ?? [];
  if (!projection.reviews && !projection.retirements && !contradictions.length) return {};
  return { note_projection: { ...projection, ...(projection.reviews ? { reviews: projection.reviews.slice(0, count) } : {}),
    ...(projection.retirements ? { retirements: projection.retirements.filter(record => record.note_index < count) } : {}),
    ...(projection.contradictions ? { contradictions } : {}) } };
}

// Usage logs are machine-wide and may be inspected or summarized outside the
// request process. A granted provider is useful attribution, but its root is
// private filesystem information. Keep only a stable, redacted identity in
// the log; the response itself may still carry the provenance needed by the
// agent in the moment.
const providerHash = (root) =>
  `sha256:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;

// Account facts belong to the resolved stack's credential, not merely a host
// that happens to share its origin. Keep their labels separate from universal
// stack/operation notes, including when no operation has yet been recorded.
function withAccountFacts(known, url) {
  const runtime = clientRuntime(), target = authContextFor(url), scope = currentStackScope();
  if (!runtime.stack || !scope || scope.stack !== runtime.stack || !target?.auth || target.name !== null
    || !httpContextScope(url, target, { baseUrl: runtime.base, baseUrlSource: runtime.config.baseUrlSource }).eligible) return known;
  try {
    const receipt = readAccountFacts(runtime.root, { scope,
      config: { ...runtime.config, auth: target.auth, credentialEnvFiles: target.credentialEnvFiles },
      credentials: runtime.accountCredentials.get(target), maxFacts: 5 });
    if (!receipt.total && !receipt.issues?.length) return known;
    const records = receipt.records.map(({ id, text, at, by, evidence, shared, credential_reference, credential_state }) =>
      ({ id, text, at, by, evidence, shared, credential_reference, credential_state }));
    const changed = receipt.credential_changed ?? records.filter(record => record.credential_state === 'changed').length;
    return { ...known, account_facts: { ...receipt, records,
      ...(changed ? { credential_changed: changed, warning: 'credential changed since observed' } : {}) } };
  } catch {
    // Delivery failures are visible without exposing a local path or the raw
    // storage error. They never change the API request's success or failure.
    return { ...known, account_facts: { records: [], total: null, shown: 0, omitted: null,
      issues: [{ code: 'ACCOUNT_FACTS_UNAVAILABLE' }],
      show_command: `${CLI_NAME} show --stack ${runtime.stack} --env ${runtime.config.name ?? 'default'} --scope account` } };
  }
}

function accountFactReceiptAfterTrim(known, kept = 0) {
  if (!known?.account_facts) return {};
  const receipt = known.account_facts, records = receipt.records?.slice(0, kept) ?? [];
  return { account_facts: { ...receipt, records, shown: records.length, omitted: receipt.total === null ? null : receipt.total - records.length } };
}

// What earlier sessions established about THIS operation, delivered at the
// moment it is actionable rather than 40 turns earlier. Confidence is graded
// from git, so an agent can tell a fresh claim from one whose implementation
// has moved since it was checked.
// Source locations are local declarations, not execution evidence. Keep their
// cost inside the same envelope budget as API knowledge. One invocation owns
// the lazy scan, so the preflight and response projections reuse it.
function measureKnownCode(code) {
  if (!code) return;
  code.bytes = 0;
  for (let n = 0; n < 4; n++) {
    const size = Buffer.byteLength(JSON.stringify(code));
    if (code.bytes === size) break;
    code.bytes = size;
  }
}
function withKnownCode(known, operation) {
  const runtime = clientRuntime();
  // A named stack supplies the repository/environment ownership for this
  // delivery. Legacy requests keep their existing cached context read path.
  if (!runtime.stack || !operation || process.env.API_CONTEXT_OFF === '1') return known;
  let locations;
  try { locations = forOperationCode(runtime.root, runtime.stack, operation); }
  catch { return known; } // Navigation must not change the request outcome.
  const code = { basis: 'declared by code' };
  const inEnvironment = location => !location.environments?.length || location.environments.includes(runtime.config.name ?? 'default');
  const hasCurrent = ['defined_in', 'called_from'].some(key =>
    locations?.[key]?.some(location => inEnvironment(location) && location.state === 'current'));
  let shown = 0, total = 0;
  for (const key of ['defined_in', 'called_from']) {
    for (const location of locations?.[key] ?? []) {
      if (!inEnvironment(location)) continue;
      // Historical init attribution is still visible in read views and saved
      // knowledge. It must not crowd out a current, scoped location in known.
      if (hasCurrent && location.state === 'remembered') continue;
      total++;
      if (shown >= 5) continue;
      // Missing or remembered locations are never represented as current ones.
      const state = location.state === 'not-found' ? 'not_found'
        : location.state === 'remembered' ? 'remembered' : key;
      const value = `${location.file}${location.line ? `:${location.line}` : ''}`;
      (code[state] ??= []).push(value);
      shown++;
    }
  }
  if (!total) return known;
  if (total > shown) code.omitted = total - shown;
  measureKnownCode(code);
  return { ...known, op: known?.op ?? operation, code };
}
function omitKnownCode(known) {
  if (!known?.code) return;
  const code = known.code;
  const count = ['defined_in', 'called_from', 'not_found', 'remembered']
    .reduce((sum, key) => sum + (code[key]?.length ?? 0), code.omitted ?? 0);
  delete known.code;
  known.withheld = { ...known.withheld, code: count };
}
function withSavedRequests(known, operation) {
  const runtime = clientRuntime();
  try {
    const saved = savedRequestContext(runtime.root, { stack: runtime.stack, environment: runtime.config.name,
      operation, maxBytes: Math.min(800, Math.max(128, runtime.budget)) });
    return saved ? { ...known, op: known?.op ?? operation, saved_requests: saved } : known;
  } catch { return known; } // Discovery never changes an execution outcome.
}
function omitSavedRequests(known) {
  if (!known?.saved_requests) return;
  const saved = known.saved_requests;
  delete known.saved_requests;
  known.withheld = { ...known.withheld, saved_requests: saved.requests.length + saved.omitted };
}
function measureSavedRequests(known) {
  const saved = known?.saved_requests;
  if (!saved) return;
  const measure = () => { saved.bytes = 0; for (let i = 0; i < 5; i++) saved.bytes = Buffer.byteLength(JSON.stringify(saved)); };
  const bound = Math.min(800, Math.max(128, clientRuntime().budget));
  measure();
  // Redaction may expand a short reference. Account for the actual delivered
  // bytes, and retain omission accounting instead of exceeding the bound.
  while (saved.bytes > bound && saved.requests.length) { saved.requests.pop(); saved.omitted++; measure(); }
  if (saved.bytes > bound) omitSavedRequests(known);
}
//
// A local MISS falls back to granted providers — global understanding at the
// local level. The local file above is re-read whenever it changes; the
// registry and the provider's file are read per request with no cache at all,
// because query-time truth is the registry's whole design: a grant revoked
// mid-session must be dead on the very next call of a server that never
// restarted, and any cache here would quietly convert "revoked" into "revoked
// at the next restart". Local always wins; a provider is consulted only when
// this repo knows nothing. Matching
// is crossLookup's own (exact key, then substring — none of contextFor's
// slash/template tolerance), deliberately: giving the server a more generous
// matcher than `show` would make the two answer differently for the same
// grant, which is the disagreement sharing the function exists to prevent.
function knownFor(method, url) {
  if (process.env.API_CONTEXT_OFF === '1') return null;
  const scope = httpContextScope(url, authContextFor(url), { baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource });
  if (!scope.eligible || !scope.primary && !clientRuntime().stack
    || clientRuntime().config.file && clientRuntime().config.baseUrlOverride && process.env.API_CONTRACT === undefined) return null;
  const pathname = url.pathname;
  // One read of each file, here, at the moment the answer is assembled: a note
  // written a second ago and a contract edited a second ago are both already
  // true of what this request returns.
  const ctx = clientRuntime().contextReader?.current()?.ctx ?? null;
  const mcp = knownMcpTool(ctx, pathname);
  let hit = contextFor(ctx, method, pathname);
  let factOperation = hit?.op ?? null;
  // Named stacks own separate stores. Their contract may be mounted below a
  // base path, while authored note keys retain the contract's METHOD /path.
  // Reuse capture's existing identity/mount resolution rather than inventing
  // another route matcher or looking in the default stack's knowledge.
  if (!hit && clientRuntime().stack) {
    const identity = httpContextIdentity(url, authContextFor(url), { method,
      baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource,
      environment: clientRuntime().config.name, stack: clientRuntime().stack });
    factOperation = identity?.operation ?? null;
    if (identity && ctx?.operations?.[identity.operation])
      hit = { op: identity.operation, entry: ctx.operations[identity.operation] };
    // Without a contract, only the configured base prefix is known. It is
    // already segment-bounded by scope eligibility above. This recovers an
    // authored relative operation key; it neither captures nor verifies it.
    // A declared but unresolved contract never takes this fallback.
    if (!identity && !authContextFor(url)?.contract) {
      const prefix = new URL(clientRuntime().base).pathname.replace(/\/+$/u, '');
      if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`)))
        hit = contextFor(ctx, method, pathname.slice(prefix.length) || '/');
      factOperation = hit?.op ?? `${method} ${prefix ? pathname.slice(prefix.length) || '/' : pathname}`;
    }
  }
  const contractDigest = clientRuntime().contractDigestReader.current(ctx);
  const noteOptions = { staleDays: clientRuntime().config.defaults.staleDays,
    freshness: freshnessFor(hit?.entry ?? {}, clientRuntime().root, contractDigest, Date.now(), { commits: false }) };
  if (factOperation) try {
    Object.assign(noteOptions, loadNoteReadContext(clientRuntime().root, ctx, { config: clientRuntime().config,
      contract: authContextFor(url)?.httpContract }).forOperation(factOperation));
  } catch { /* Unavailable enrichment cannot break a request or invent a contradiction. */ }
  if (factOperation) try {
    noteOptions.summary = showObservationSummary(clientRuntime().root, factOperation, {
      config: clientRuntime().config, contract: authContextFor(url)?.httpContract });
  } catch { /* Missing or unreadable evidence leaves notes written, never verified. */ }
  const local = hit ? { ...knownBlock(hit.op, hit.entry, clientRuntime().root, contractDigest, null, noteOptions),
    ...(clientRuntime().stack ? { applicability: { stack: clientRuntime().stack, provider: scope.provider,
      environment: clientRuntime().config.name ?? 'default', basis: 'resolved-stack-request' } } : {}),
    ...(mcp ? { mcp } : {}) } : null;
  const enriched = withSavedRequests(withKnownCode(withAccountFacts(prependStackFacts(local, ctx, { stack: clientRuntime().stack, operation: factOperation,
    rankRecords: records => rankNoteRecords(records, noteOptions) }), url), factOperation), factOperation);
  if (enriched) return { ...enriched,
    ...(!local ? { applicability: { stack: clientRuntime().stack, provider: scope.provider,
      environment: clientRuntime().config.name ?? 'default', basis: 'resolved-stack-request' } } : {}) };
  // Off means off: the env var that disables local context disables the
  // cross-repo consult with it, or the control arm of every measurement would
  // quietly keep half the treatment.
  if (process.env.API_CONTEXT_OFF === "1") return null;
  if (mcp) return mcp;
  try {
    const cross = crossLookup(clientRuntime().root, `${method} ${pathname}`, process.env);
    if (!cross) return null;
    // The provider's STORED contract digest, mirroring what the local branch
    // grades against — never a fresh hash of the provider's contract file,
    // which would bill every request for reading and hashing a spec that can
    // be megabytes. `show` pays that once per invocation; a per-request
    // sensor does not.
    return knownBlock(cross.key, cross.entry, cross.provider.root,
      cross.ctx?.api?.contract_digest,
      { repo: cross.provider.name, root: cross.provider.root });
  } catch {
    // Failure containment: crossLookup already degrades a damaged registry,
    // an unregistered consumer, a vanished root, and an unreadable provider
    // file to null; this catch is the belt for anything it did not foresee.
    // Enrichment must never break the request it decorates (the same rule
    // friction detection lives under).
    return null;
  }
}

function scopedKnownFor(method, url, legacy) {
  if (process.env.API_CONTEXT_OFF === '1') return legacy;
  try {
    const identity = httpContextIdentity(url, authContextFor(url), { method,
      baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource, environment: clientRuntime().config.name ?? 'default', stack: clientRuntime().stack ?? undefined });
    const scoped = queryHttpContext(clientRuntime().root, identity, { maxBytes: Math.max(512, Math.min(16000, clientRuntime().budget * 2)) });
    // The top-level known projection already delivered the five-fact prefix.
    // Explicit context queries can show more, but request enrichment must not
    // smuggle an uncapped duplicate into its scoped observation record.
    if (scoped) delete scoped.stack_facts;
    const tests = queryImportedTestClaims(clientRuntime().root, { url, target: authContextFor(url), method,
      baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource }, { maxBytes: Math.max(512, Math.min(8000, clientRuntime().budget * 2)) });
    const scope = httpContextScope(url, authContextFor(url), {
      baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource });
    let scopedGrade;
    if (scoped && !legacy?.evidence_class && !legacy?.from && identity) {
      const ctx = clientRuntime().contextReader?.current()?.ctx;
      const entry = ctx?.operations?.[identity.operation] ?? {};
      scopedGrade = evidenceClass({ entry, summary: showObservationSummary(clientRuntime().root, identity.operation, {
        config: clientRuntime().config, contract: authContextFor(url)?.httpContract }),
        freshness: freshnessFor(entry, clientRuntime().root, clientRuntime().contractDigestReader.current(ctx), Date.now(), { commits: false }),
        staleDays: clientRuntime().config.defaults.staleDays });
    }
    return scoped || tests ? { ...legacy,
      // A scoped-only observation has no legacy block to carry this receipt.
      // Cross-repo legacy facts keep their unknown applicability rather than
      // acquiring the current request's identity by proximity.
      ...(!legacy && clientRuntime().stack && scope.eligible ? { applicability: { stack: clientRuntime().stack,
        provider: scope.provider, environment: clientRuntime().config.name ?? 'default', basis: 'resolved-stack-request' } } : {}),
      ...(scoped ? { scoped } : {}), ...(scopedGrade ? { evidence_class: scopedGrade } : {}),
      ...(tests ? { from_tests: tests } : {}) } : legacy;
  } catch { return legacy; } // Context delivery must never change the request outcome.
}


// Client defaults are resolved once, in config.mjs, with env > config-file
// `defaults` block > built-in precedence. Reading them from CONFIG.defaults
// here (rather than process.env directly) is what lets a project set a budget,
// timeout, or evidence dir in the file it commits, while an env var still wins.


// The standard request envelope shape keeps every key present so an agent never inspects a
// response to learn how to read it. That guarantee has a price: even with the
// body, shape, facets and friction prompt all stripped, the envelope does not
// go below roughly this many tokens. Measured, not estimated, and pinned by a
// test so it cannot drift upward unnoticed.
export const ENVELOPE_FLOOR = 130;
export const EVIDENCE = resolve(DEFAULT_CONTEXT_ROOT, DEFAULT_CONFIG.defaults.evidenceDir);

function safeSaveDestination(value) {
  const dest = resolve(String(value));
  const root = resolve(clientRuntime().root);
  const evidence = resolve(clientRuntime().evidence);
  const inside = (base) => dest === base || dest.startsWith(`${base}${sep}`);
  if (!inside(root) && !inside(evidence) && process.env[ALLOW_SAVE_OUTSIDE_ENV_NAME] !== "1")
    throw Object.assign(new Error(`save_to must stay inside the project or evidence directory; set ${ALLOW_SAVE_OUTSIDE_ENV_NAME}=1 for an explicit outside-project write`), { code: "SAVE_TO_OUTSIDE_PROJECT" });
  safeOutputPath(dest, { code: "SAVE_TO_UNSAFE_PATH" });
  return dest;
}

// Evidence holds COMPLETE request and response pairs: every body, every header,
// with configured and detected response secrets masked. Other response values
// remain private and must never be committed.
//
// The promotion boundary exists to stop response values reaching a committed
// file, and it was carefully built and tested. Meanwhile this directory was
// being created inside the user's repo with no protection at all, so a single
// `git add -A` would have put every response body into git history permanently,
// walking straight around the boundary. The design called evidence "gitignored"
// from the start; nothing implemented it.
//
// A self-ignoring .gitignore inside the directory needs no cooperation from the
// repo's existing ignore file, and works in a repo that has none.
function protectEvidence(dir) {
  // Private execution evidence remains available before migration. Do not run
  // the committed-layout writer (which rightly refuses old layouts) merely to
  // protect an evidence folder; its own ignore marker is sufficient here.
  if (resolve(dir) === resolve(clientRuntime().root, LAYOUT.evidence)
    && !stacksMigrationCapture(clientRuntime().root)) ensureLayout(clientRuntime().root);
  const marker = join(dir, ".gitignore");
  const header =
    "# Written by the API client. Evidence holds complete response bodies and\n" +
    "# headers; committing it would publish everything the API ever returned.\n";
  try {
    // A pre-existing .gitignore does NOT mean evidence is protected. When
    // API_EVIDENCE points at a repo root or a project subdir that already has
    // one, early-returning left the response bodies trackable — verified: a
    // `git add -A` staged them. So ensure the rule is actually present rather
    // than assuming the file covers it, and append scoped rules rather than
    // clobbering a file the user owns.
    safeOutputPath(marker);
    if (!existsSync(marker)) { writeOutputFile(marker, `${header}*\n`); return; }
    const current = readFileSync(marker, "utf8");
    if (/^\s*\*\s*$/m.test(current)) return;                       // already ignores everything
    const needed = ["run-*.json", "run-*.bin", "*.bin"].filter((r) => !current.split("\n").includes(r));
    if (!needed.length) return;
    writeOutputFile(marker,
      `${current.endsWith("\n") ? "" : "\n"}# api client evidence (response bodies) — do not commit\n${needed.join("\n")}\n`, { append: true });
  } catch { throw Object.assign(new Error("Evidence ignore rules could not be protected."), { code: "EVIDENCE_PROTECTION_FAILED" }); }
}

// If evidence is ALREADY tracked, ignoring it now changes nothing: the contents
// are in history. That has to be said out loud rather than quietly fixed going
// forward, because the remedy is rewriting history and rotating anything the
// responses contained.
function warnIfEvidenceTracked(dir) {
  try {
    const tracked = execFileSync("git", ["ls-files", "--", dir],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!tracked) return;
    process.stderr.write(
      `\n[api-client] WARNING: ${tracked.split("\n").length} evidence file(s) are tracked by git ` +
      `in ${dir}.\nEvidence contains complete response bodies and headers. They are already in ` +
      `history, so ignoring them now does not remove them.\nRemove them from the index, and treat ` +
      `anything those responses contained as exposed.\n`);
  } catch { /* not a git repo, or git unavailable: nothing to warn about */ }
}

export const tokens = (s) => Math.ceil(s.length / 4);

// --- usage log ------------------------------------------------------------
// One append-only line per call, global across repos so it accumulates into a
// real answer about where API work actually goes. Records shape and origin
// only: no bodies, no headers, no query VALUES (a value can be a token).
export const USAGE_LOG = machineStatePaths().usageLog;

const VENDOR_HOST = /\b(?:stripe|openai|anthropic|twilio|supabase|github|googleapis|google|slack|notion|linear|resend|sendgrid|posthog|mixpanel|sentry|algolia|pinecone|cloudinary|plaid|shopify|square|amazonaws|firebase|vercel|upstash|planetscale|neon|pokeapi|openweathermap|spotify|discord|hubspot|airtable|clerk|auth0|okta)\b/i;
// Content types whose bytes mean nothing as text.
const BINARY_TYPE = /^(image|audio|video|font)\/|application\/(pdf|zip|gzip|x-tar|octet-stream|vnd\.ms|vnd\.openxmlformats|wasm)/i;
const isBinaryType = (ct) => BINARY_TYPE.test(ct);

// Response headers an agent actually acts on. Returning all of them would spend
// the budget on CDN and tracing noise; returning none made expect:[{header}]
// assert against something invisible.
const USEFUL_HEADERS = ["location", "etag", "link", "content-type", "content-length",
  "last-modified", "retry-after", "x-request-id", "x-correlation-id", "content-disposition"];
// set-cookie is deliberately absent: it goes to the jar, never to the agent.
function usefulHeaders(res) {
  const out = {};
  for (const h of USEFUL_HEADERS) {
    const v = res.headers.get(h);
    if (v != null) out[h] = secretIn(v) ? "[redacted]" : (v.length > 200 ? `${v.slice(0, 200)}…` : v);
  }
  return Object.keys(out).length ? out : null;
}

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/i;

// own = an API running on this machine (what you build against in development)
// vendor = a known third party
// other = reachable but unclassified: internal staging, a colleague's service
const originOf = (hostname) =>
  LOCAL_HOST.test(hostname) ? "own" : VENDOR_HOST.test(hostname) ? "vendor" : "other";

// Collapse ids so paths aggregate: /vehicles/42 and /vehicles/97 are one route.
const templatePath = (p) => p
  .split("/")
  .map((seg) => /^\d+$/.test(seg) ? "{id}"
    : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) ? "{uuid}"
    // Prefixed identifiers are the norm in real APIs: op_…, cus_…, evt_…, whsec_…
    : /^[a-z][a-z0-9]{0,11}_[A-Za-z0-9_-]{8,}$/.test(seg) ? "{id}"
    : /^[0-9a-f]{16,}$/i.test(seg) ? "{hash}" : seg)
  .join("/");

// --- auth -----------------------------------------------------------------
// Credentials are referenced by ENV VAR NAME, never by value. The value is read
// at request time, attached to the outbound request, and never enters an
// envelope, an evidence file, the usage log, or an error message.
//
//   API_AUTH=bearer:EDITORIAL_TOKEN
//   API_AUTH=header:X-API-Key:EDITORIAL_KEY
//   API_AUTH=query:api_key:SOME_KEY
//   API_AUTH=basic:USERNAME_ENV:PASSWORD_ENV  (UTF-8)
const MAX_REDIRECTS = Number(process.env.API_MAX_REDIRECTS ?? 5);

// Header names that carry a credential. Used to decide what must NOT survive a
// redirect to another origin: a credential is scoped to the host it was
// configured for, and a server that answers 302 to a host it controls would
// otherwise be handed the token.
// Headers safe to present to ANY host a redirect names. Everything else the
// caller supplied — custom auth headers included, which a denylist cannot
// enumerate — is dropped on a cross-origin hop. Body-preserving cross-origin
// redirects are refused, so content headers have no reason to cross either.
const SAFE_CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "accept-encoding",
  "user-agent"]);

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie",
  "x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token", "x-session-token"]);

function parseAuth(spec) {
  if (!spec) return null;
  return parseAuthReference(spec) ?? { scheme: 'invalid', raw: 'invalid reference' };
}

// --- oauth ----------------------------------------------------------------
//   API_AUTH=oauth:CLIENT_ID_ENV:CLIENT_SECRET_ENV
//   API_OAUTH_TOKEN_URL=https://provider/token
//   API_OAUTH_SCOPE="read write"                (optional)
//   API_OAUTH_REFRESH_TOKEN_ENV=MY_REFRESH      (optional; uses refresh_token grant)
//
// Tokens are cached on disk so separate CLI invocations do not each mint a new
// one. The cache holds the access token, so it is written 0600 and keyed by a
// hash of the provider and credential set. No credential values appear in the
// filename; rotating credentials cannot reuse the old set's cached grant.
// Compatibility export for the primary provider only. Dispatch resolves its
// own snapshot below; another host's file is never a global endpoint fallback.
export const TOKEN_URL = credentialEnvironment(DEFAULT_CONFIG.credentialEnvFiles).API_OAUTH_TOKEN_URL;
export const TOKEN_CACHE = machineStatePaths().tokenCache;
const REFRESH_SKEW_MS = 5_000;   // refresh early; a token that expires mid-flight is a failed call

// Everything token-side is keyed per PROVIDER (token URL + client id), because
// with per-host auth several oauth upstreams can coexist in one process. A
// single memoryToken/inFlightGrant slot would hand host A's freshly minted
// token to host B's cache — the exact cross-host leak this feature forbids.
const memoryTokens = new Map();   // cachePath -> token
// With concurrency, N callers can find the token expired at the same instant.
// Without this, each mints one — and against single-use rotating refresh tokens
// all but one of those grants is invalid. Share the in-flight request instead.
const inFlightGrants = new Map(); // cachePath -> Promise

const cachePath = (auth, clientId) =>
  join(TOKEN_CACHE, `${createHash("sha256").update(JSON.stringify([
    auth.tokenUrl, clientId, auth.environment[auth.clientSecretEnv], auth.scope ?? null,
    auth.environment[auth.environment.API_OAUTH_REFRESH_TOKEN_ENV] ?? null,
  ])).digest("hex").slice(0, 32)}.json`);

function readCachedToken(auth, clientId) {
  const key = cachePath(auth, clientId);
  const inMemory = memoryTokens.get(key);
  if (inMemory && inMemory.expiresAt > Date.now() + REFRESH_SKEW_MS) return inMemory;
  for (const directory of tokenCachePaths()) {
    const diskKey = join(directory, basename(key));
    // Check each file, not just its directory: an unrelated current provider
    // cache must not hide this provider's legacy token. Linked files never read.
    try { safeOutputPath(diskKey); } catch { continue; }
    let text;
    try { text = readFileSync(diskKey, "utf8"); }
    catch (error) { if (error.code === 'ENOENT') continue; return null; }
    // An existing current entry is authoritative, including expiry or malformed
    // content. Do not resurrect a stale legacy grant over a newer cache entry.
    let t;
    try { t = JSON.parse(text); } catch { return null; }
    if (!t || typeof t.accessToken !== 'string' || !t.accessToken) return null;
    if (t.expiresAt > Date.now() + REFRESH_SKEW_MS) { memoryTokens.set(key, t); return t; }
    return t.refreshToken ? { ...t, expired: true } : null;
  }
  return null;
}

async function writeCachedToken(auth, clientId, tok) {
  const key = cachePath(auth, clientId);
  memoryTokens.set(key, tok);
  try {
    await withMachineStateWrite("tokens", directory => {
      const diskKey = join(directory, basename(key));
      safeOutputPath(diskKey);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeOutputFileAtomic(diskKey, JSON.stringify(tok), { mode: 0o600 });
    });
  } catch { /* cache is an optimisation, not a requirement */ }
}

async function grant(auth, form, signal) {
  const clientId = auth.environment[auth.clientIdEnv];
  const clientSecret = auth.environment[auth.clientSecretEnv];
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  if (auth.scope) form.set("scope", auth.scope);

  const res = await fetch(auth.tokenUrl, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form, signal,
  });
  if (res.status >= 300 && res.status < 400)
    return { error: { kind: "auth", code: "OAUTH_REDIRECT_REFUSED", message: "Token endpoint redirects are not followed with credentials." } };
  const text = await readResponseText(res);
  let payload; try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 200) }; }
  if (!res.ok)
    return { error: { kind: "auth", code: "OAUTH_GRANT_REJECTED",
      message: `Token endpoint rejected the grant with status ${res.status}.`,
      details: { grant_type: form.get("grant_type"), token_url: auth.tokenUrl },
      next: payload?.error === "invalid_client"
        ? `Check the values of ${auth.clientIdEnv} and ${auth.clientSecretEnv}.`
        : "Check API_OAUTH_TOKEN_URL and the configured grant." } };
  boundResponseJson(payload);
  if (!payload || typeof payload !== 'object' || typeof payload.access_token !== 'string' || !payload.access_token)
    return { error: { kind: "auth", code: "OAUTH_NO_ACCESS_TOKEN",
      message: "Token endpoint returned 2xx without an access_token.",
      next: "Verify API_OAUTH_TOKEN_URL points at a token endpoint, not an authorize endpoint." } };

  return { token: {
    accessToken: payload.access_token,
    // Providers commonly rotate refresh tokens; keep the newest one we were given.
    refreshToken: payload.refresh_token ?? form.get("refresh_token") ?? null,
    expiresAt: Date.now() + (Number(payload.expires_in ?? 3600) * 1000),
    scope: payload.scope ?? null,
  } };
}

async function oauthToken(auth, { force = false, signal } = {}) {
  if (isBuiltinFeedbackTarget(auth.tokenUrl))
    return { error: { kind: 'policy', code: 'FEEDBACK_REQUEST_INVALID', message: 'The feedback service cannot be used as an OAuth token endpoint. Nothing was sent there.' } };
  if (!auth.tokenUrl)
    return { error: { kind: "config", code: "OAUTH_TOKEN_URL_MISSING",
      message: "An oauth credential requires a token endpoint.",
      next: `Set API_OAUTH_TOKEN_URL, or give the host entry a tokenUrl in ${LAYOUT.environments}.` } };
  for (const v of [auth.clientIdEnv, auth.clientSecretEnv])
    if (!auth.environment[v])
      return { error: { kind: "config", code: "AUTH_ENV_MISSING",
        message: `API_AUTH references environment variable ${v}, which is not set.`,
        next: `Export ${v}. The value is never logged.` } };

  const clientId = auth.environment[auth.clientIdEnv];
  const cached = force ? null : readCachedToken(auth, clientId);
  if (cached && !cached.expired) return { token: cached };

  // Prefer refreshing over re-authenticating: it is what the provider expects,
  // and client_credentials may not even be enabled for this client.
  const seedRefresh = auth.environment.API_OAUTH_REFRESH_TOKEN_ENV
    ? auth.environment[auth.environment.API_OAUTH_REFRESH_TOKEN_ENV] : null;
  const refreshToken = cached?.refreshToken ?? seedRefresh;
  if (refreshToken) {
    const r = await grant(auth, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }), signal);
    if (r.token) { await writeCachedToken(auth, clientId, r.token); return r; }
    // A rotated-away or revoked refresh token is recoverable: fall through.
  }
  const r = await grant(auth, new URLSearchParams({ grant_type: "client_credentials" }), signal);
  if (r.token) await writeCachedToken(auth, clientId, r.token);
  return r;
}

// Public entry point: everything above is the uncoalesced implementation.
// Coalesced PER PROVIDER — a shared single slot would return host A's grant to
// host B's caller whenever their refreshes happened to overlap.
async function oauthTokenShared(auth, opts) {
  const key = cachePath(auth, auth.environment[auth.clientIdEnv]);
  const existing = inFlightGrants.get(key);
  if (existing) return existing;
  const p = oauthToken(auth, opts).finally(() => inFlightGrants.delete(key));
  inFlightGrants.set(key, p);
  return p;
}

// --- per-host credential routing (F1) --------------------------------------
// One client instance, many credential sets. Named upstreams come from the
// config's `hosts` map; each carries its own base URL and auth reference. The
// resolution rule is the security property: a credential is chosen by the
// ORIGIN of the URL actually being fetched, never by what the caller claims,
// so host A's credential structurally cannot be attached to a request whose
// URL points at host B.
// The base path is the specificity key BETWEEN same-origin siblings ("" means
// the origin root). Normalised without a trailing slash so /v1 and /v1/ are the
// same entry, not two.
const basePathOf = (u) => { const p = new URL(u).pathname; return p === "/" ? "" : p.replace(/\/$/, ""); };

// A rejected contract or a skipped route must be visible at runtime as well
// as in doctor. Diagnostics contain structural metadata only, never payloads
// or a path's literal query values. Each stack binds its own contract here.
const emittedContractDiagnostics = new Set();
function bindHttpContract(file, pathPrefix) {
  const httpContractDiagnostics = [];
  const httpContract = file == null ? null : loadHttpContract(file, { pathPrefix, onDiagnostic: diagnostic => {
    httpContractDiagnostics.push(diagnostic);
    const detail = diagnostic.message ?? `${diagnostic.path ?? ''} ${diagnostic.reason}`.trim();
    const line = `${terminalText(diagnostic.code)}: ${terminalText(redactMetadataSecrets(detail))}\n`;
    if (!emittedContractDiagnostics.has(line)) {
      emittedContractDiagnostics.add(line);
      // Diagnostics are best effort: a closed warning consumer cannot prevent
      // the request or its evidence. Synchronous fd writes fail inside this
      // catch rather than emitting an unhandled asynchronous stream error.
      try { writeSync(2, line); } catch { /* warning sink unavailable */ }
    }
  } });
  return { httpContract, httpContractDiagnostics };
}

// Each dispatch owns its configuration and routing table. A long-lived MCP
// process must never mutate process.env or borrow another stack's auth, cookie,
// evidence or contract state while concurrent requests are running.
function createClientRuntime(scope = null) {
  const config = scope?.config ?? DEFAULT_CONFIG;
  const root = scope?.root ?? DEFAULT_CONTEXT_ROOT;
  // An unresolved multi-stack catalog intentionally has no default API. This
  // inert startup table is never a dispatch choice: resolveStack must succeed
  // before an ordinary request reaches it.
  const base = config.baseUrl ?? FALLBACK_BASE_URL;
  const upstreams = new Map(), originAuth = new Map();
  const add = (ctx, { displaces = false } = {}) => {
    const list = originAuth.get(ctx.origin) ?? [];
    const twin = list.find(item => item.basePath === ctx.basePath);
    if (twin && displaces) list[list.indexOf(twin)] = ctx;
    else if (twin) twin.collision = [...new Set([...(twin.collision ?? [twin.name]), ctx.name])];
    else list.push(ctx);
    list.sort((a, b) => b.basePath.length - a.basePath.length);
    originAuth.set(ctx.origin, list);
  };
  for (const [name, host] of Object.entries(config.hosts ?? {})) {
    try {
      const upstream = { name, baseUrl: host.baseUrl, origin: new URL(host.baseUrl).origin,
        basePath: basePathOf(host.baseUrl), auth: host.auth, headers: host.headers ?? {},
        tokenUrl: host.tokenUrl, scope: host.scope, credentialEnvFiles: host.credentialEnvFiles,
        production: Boolean(host.production), contract: host.contract,
        contractPathPrefix: host.contractPathPrefix,
        ...bindHttpContract(host.contract, host.contractPathPrefix) };
      upstreams.set(name, upstream); add(upstream);
    } catch { upstreams.set(name, { name, invalid: true }); }
  }
  const contract = !config.baseUrlOverride || process.env.API_CONTRACT !== undefined ? config.contract : null;
  const baseOrigin = new URL(base).origin;
  add({ name: null, baseUrl: base, origin: baseOrigin, basePath: basePathOf(base),
    auth: config.auth, headers: config.headers ?? {}, credentialEnvFiles: config.credentialEnvFiles,
    production: config.production, tokenUrl: config.tokenUrl, scope: config.scope, contract, contractPathPrefix: config.contractPathPrefix,
    ...bindHttpContract(contract, config.contractPathPrefix) }, { displaces: true });
  const concurrency = Math.max(1, config.concurrency);
  return { config, root, stack: scope?.stack ?? null, base, baseOrigin, accountCredentials: new WeakMap(),
    auth: config.auth, upstreams, originAuth,
    budget: config.defaults.budget, timeoutMs: config.defaults.timeoutMs,
    evidence: resolve(root, scope?.evidenceDir ?? config.defaults.evidenceDir),
    contextReader: process.env.API_CONTEXT_OFF === '1' ? null : contextReader(root),
    contractDigestReader: process.env.API_CONTEXT_OFF === '1' ? null : contractDigestReader(root),
    concurrency, concurrencyMax: Math.max(concurrency, Number(process.env.API_CONCURRENCY_MAX ?? 8)),
    partition: JSON.stringify([root, scope?.stack ?? null, config.name ?? null]) };
}
const DEFAULT_RUNTIME = createClientRuntime();

// The capability report uses the same provider-local destination fallback as
// auth dispatch. Only endpoint names leave this helper, never credential values.
export function configuredOAuthTokenUrls() {
  const urls = new Set();
  for (const contexts of clientRuntime().originAuth.values()) for (const ctx of contexts) {
    if (ctx.collision || parseAuth(ctx.auth)?.scheme !== 'oauth') continue;
    const destination = ctx.tokenUrl ?? credentialEnvironment(ctx.credentialEnvFiles).API_OAUTH_TOKEN_URL;
    if (destination) urls.add(destination);
  }
  return [...urls].sort();
}

// The auth context for a URL: same origin, then the most specific base path
// that segment-prefixes the request path (so /v1 never claims /v12). A single
// entry keeps owning its whole origin — today's behaviour, which existing
// configs rely on. With siblings, a path under NONE of them gets no credential:
// same origin, but no entry claimed it, and guessing between siblings is
// exactly the wrong-credential bug this function replaces.
function authContextFor(url) {
  const list = clientRuntime().originAuth.get(url.origin);
  if (!list) return null;
  if (list.length === 1 && !clientRuntime().stack) return list[0];
  return list.find((c) => c.basePath === ""
    || url.pathname === c.basePath || url.pathname.startsWith(`${c.basePath}/`)) ?? null;
}

// Same-origin gateways can host independently authenticated providers. A hop
// outside an explicitly configured base prefix also leaves that provider,
// even when the legacy single-origin auth lookup returns the same context.
function crossesProviderScope(from, to) {
  if (from.origin !== to.origin || authContextFor(from) !== authContextFor(to)) return true;
  const config = { baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource };
  return httpContextScope(from, authContextFor(from), config).eligible
    && !httpContextScope(to, authContextFor(to), config).eligible;
}

// Where does this request actually go? Three forms:
//   path only                → the base URL (unchanged, the common case)
//   upstream: "name" + path  → that upstream's base URL
//   path is a full URL       → allowed ONLY for a configured origin; anything
//                              else is refused, because "just send it" to an
//                              arbitrary host is how a placeholder resolved
//                              from server data becomes an exfiltration channel.
function resolveTarget(path, upstreamName) {
  const p = String(path ?? "");
  if (upstreamName != null) {
    const u = clientRuntime().upstreams.get(String(upstreamName));
    if (!u)
      return { error: { kind: "config", code: "UPSTREAM_NOT_FOUND",
        message: `No upstream named '${upstreamName}' is configured.`,
        details: { available: [...clientRuntime().upstreams.keys()] },
        next: `Declare it under "hosts" in ${LAYOUT.environments}, or use one of: ${[...clientRuntime().upstreams.keys()].join(", ") || "(none)"}.` } };
    if (u.invalid)
      return { error: { kind: "config", code: "UPSTREAM_INVALID",
        message: `Upstream '${upstreamName}' has no usable baseUrl.`,
        next: `Give hosts.${upstreamName}.baseUrl an absolute URL.` } };
    const url = new URL(u.baseUrl + (p.startsWith("/") ? p : `/${p}`));
    return { url, context: authContextFor(url) };
  }
  if (/^https?:\/\//i.test(p)) {
    let abs;
    try { abs = new URL(p); }
    catch { return { error: { kind: "config", code: "URL_INVALID",
      message: "The supplied absolute URL is not valid.",
      next: "Fix the URL, or pass a path plus an upstream name." } }; }
    if (!clientRuntime().originAuth.has(abs.origin))
      return { error: { kind: "policy", code: "ORIGIN_NOT_CONFIGURED",
        message: `${abs.origin} is not the base URL and not a configured host, so the request was not sent.`,
        details: { requested: abs.origin, configured: [clientRuntime().baseOrigin, ...[...clientRuntime().upstreams.values()].filter((u) => !u.invalid).map((u) => u.origin)] },
        next: `Declare the host under "hosts" in ${LAYOUT.environments} with its own auth reference, or point API_BASE_URL at it.` } };
    return { url: abs, context: authContextFor(abs) };
  }
  const url = new URL(clientRuntime().base + (p.startsWith("/") ? p : `/${p}`));
  return { url, context: authContextFor(url) };
}

// Error paths can still carry the same recorded context as a successful
// request when the target is known. Invalid or unknown targets return null;
// enrichment must never guess which operation a refusal belongs to.
function knownForTarget(method, path, upstream) {
  try {
    const target = resolveTarget(path, upstream);
    return target.error ? null : knownFor(String(method ?? "GET").toUpperCase(), target.url);
  } catch { return null; }
}

// Applies auth and returns the set of secret values to scrub from any output.
// The credential is looked up by the URL's origin — the request's HOST decides,
// which is what makes cross-host leakage structural rather than disciplined.
async function applyAuth(url, init, { forceRefresh = false, signal } = {}) {
  const ctx = authContextFor(url);
  // A collision means two config entries both claim this exact origin+path.
  // Either credential is a coin flip, and a coin flip with credentials is the
  // bug class this whole map exists to prevent — refuse and name the entries.
  if (ctx?.collision)
    return { error: { kind: "config", code: "HOST_CONFIG_AMBIGUOUS",
      message: `Hosts ${ctx.collision.map((n) => n === null ? "(base URL)" : `'${n}'`).join(" and ")} ` +
        `share the same origin and base path (${ctx.origin}${ctx.basePath || "/"}), so the credential choice is ambiguous.`,
      details: { origin: ctx.origin, basePath: ctx.basePath || "/", entries: ctx.collision },
      next: `Give each same-origin host entry a distinct base path in ${LAYOUT.environments}, or remove the duplicate.` } };
  // Where the spec came from, for error messages that name the fixable thing.
  const source = ctx?.name ? `hosts.${ctx.name}.auth` : "API_AUTH";
  const auth = parseAuth(ctx?.auth);
  if (!auth) return { secrets: [], authUsed: null };
  auth.environment = credentialEnvironment(ctx?.credentialEnvFiles);
  // Account applicability is judged against the values used by this attempt,
  // not a file rotation that happened while the request was in flight.
  if (ctx) clientRuntime().accountCredentials.set(ctx, auth.environment);
  if (auth.scheme === "oauth") {
    auth.tokenUrl = ctx.tokenUrl ?? auth.environment.API_OAUTH_TOKEN_URL;
    auth.scope = ctx.scope ?? auth.environment.API_OAUTH_SCOPE;
    const r = await oauthTokenShared(auth, { force: forceRefresh, signal });
    if (r.error) return { error: r.error };
    init.headers.authorization = `Bearer ${r.token.accessToken}`;
    return {
      secrets: [r.token.accessToken, r.token.refreshToken].filter(Boolean),
      authUsed: `oauth:${auth.clientIdEnv}`,
      canRetry: true,
    };
  }
  if (auth.scheme === "invalid")
    return { error: { kind: "config", code: "AUTH_SPEC_INVALID",
      message: `${source} must be a complete credential environment-variable reference.`,
      next: `Set ${source} to bearer:ENV_VAR, header:Name:ENV_VAR, query:param:ENV_VAR, basic:USER_ENV:PASS_ENV, or oauth:CLIENT_ID_ENV:CLIENT_SECRET_ENV.` } };
  if (auth.scheme === 'basic') {
    const missing = [auth.usernameEnv, auth.passwordEnv].filter(name => !auth.environment[name]);
    if (missing.length) return { required: true, error: { kind: 'config', code: 'AUTH_ENV_MISSING',
      message: `${source} references environment variable${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not set.`,
      next: 'Supply both Basic credentials through this provider’s configured environment. Values are never logged.' } };
    const username = auth.environment[auth.usernameEnv], password = auth.environment[auth.passwordEnv];
    const problem = basicAuthValueProblem(username, password);
    if (problem) return { error: { kind: 'config', code: 'AUTH_VALUE_INVALID', message: problem,
      next: `Correct the credential values referenced by ${source}. Basic credentials use UTF-8; values are never logged.` } };
    const combined = `${username}:${password}`;
    const encoded = Buffer.from(combined, 'utf8').toString('base64');
    const authorization = `Basic ${encoded}`;
    init.headers.authorization = authorization;
    return { secrets: [username, password, combined, encoded, authorization],
      authUsed: `basic:${auth.usernameEnv}:${auth.passwordEnv}` };
  }
  const value = auth.environment[auth.envVar];
  if (!value)
    return { error: { kind: "config", code: "AUTH_ENV_MISSING",
      message: `${source} references environment variable ${auth.envVar}, which is not set.`,
      next: `Export ${auth.envVar} in the environment running this server. The value is never logged.` } };

  if (auth.scheme === "bearer") init.headers.authorization = `Bearer ${value}`;
  else if (auth.scheme === "header") init.headers[auth.name.toLowerCase()] = value;
  else url.searchParams.set(auth.param, value);
  return { secrets: [value], authUsed: `${auth.scheme}:${auth.envVar}` };
}

// Belt and braces: even though we never deliberately emit credentials, scrub any
// literal secret value out of anything we are about to persist or return.
// A backstop, so it errs toward catching more. A secret can be reflected
// transformed — url-encoded in a redirect Location, base64 in a basic-auth
// echo — and a literal-substring scrub would miss those. Cheap to also strip
// the common encodings of each secret. (No live path currently emits a secret
// transformed; this is defence in depth, per the 2026-08-14 red-team.)
const scrubForms = (v) => {
  const forms = new Set([v]);
  try { forms.add(JSON.stringify(v).slice(1, -1)); } catch { /* non-serialisable */ }
  try { forms.add(encodeURIComponent(v)); } catch { /* non-encodable */ }
  try { forms.add(Buffer.from(v).toString("base64")); } catch { /* non-encodable */ }
  return [...forms].filter((f) => f && f.length >= 6);   // never redact trivially short strings
};
// Callers declare the objects whose keys belong to our fixed schema. Everything
// below a provider-controlled body, data, header or parameter map remains fully
// scrubbed, including keys. A credential such as "ok" must not rename envelope
// fields or an evidence receipt; detecting trusted structure from payload shape
// would let a provider impersonate it, so the boundary is explicit at each call.
// These paths describe the context reader's projected records, not response
// payloads that happen to resemble them. Shape/property maps stay untrusted.
const CONTEXT_RECORD_STRUCTURES = ['', 'identity', 'observations.*', 'observations.*.evidence.*'];
const SCRUB_STRUCTURES = {
  envelope: ['', 'assertions', 'assertions.failures.*', 'rate_limit', 'known', 'known.code', 'known.saved_requests', 'known.saved_requests.requests.*', 'known.stack_facts', 'known.account_facts', 'known.account_facts.records.*', 'known.account_facts.records.*.evidence.*', 'learned', 'error', 'error.details',
    // Client-owned note output keys stay stable; all authored string values
    // (including labels, reasons, sources and retirement claims) still scrub.
    'known.note_projection', 'known.note_projection.records.*', 'known.note_projection.records.*.review',
    'known.note_projection.records.*.basis', 'known.note_projection.records.*.author',
    'known.note_projection.records.*.evidence_class', 'known.note_projection.records.*.corrections.*',
    'known.note_projection.records.*.retirement.*', 'known.note_projection.records.*.correction_suggestion',
    'known.note_projection.contradictions.*', 'known.note_projection.retirements.*', 'known.note_projection.retirements.*.claims.*',
    'known.note_history', 'known.note_history.issues.*',
    'data_secrets', 'discovery', 'pages', 'pagination', 'context_capture', 'context_capture.identity', 'context_capture.mount', 'contract_delta.*', 'binary', 'binary.body_secrets', 'binary.evidence_body_secrets', 'routing_alias',
    ...CONTEXT_RECORD_STRUCTURES.map(path => `known.scoped${path ? `.${path}` : ''}`)],
  httpEvidence: ['', 'origin', 'origin.scope', 'request', 'response', 'response.body_secrets', 'drift.*'],
  protocolResponse: ['', 'error'],
  protocolIdentity: [''],
  protocolKnown: ['', 'stack_facts', 'account_facts', 'account_facts.records.*', 'account_facts.records.*.evidence.*', ...CONTEXT_RECORD_STRUCTURES.map(path => `operations.*${path ? `.${path}` : ''}`)],
  assertions: ['', 'failures.*'],
  protocolEvidence: ['', 'identity', 'request',
    'response', 'response.error', 'assertions', 'assertions.failures.*'],
  request: [''],
  usage: [''],
};
const SCRUB_MODES = new Set(['refused', 'assert', 'passthrough', 'projection', 'summary', 'binary']);
const SCRUB_OUTCOMES = new Set(['success', 'partial', 'error', 'cancelled', 'timeout', 'incomplete']);
const SCRUB_PROTOCOLS = new Set(['http', 'graphql', 'jsonrpc', 'grpc', 'websocket']);
const FIXED_SCRUB_VALUES = {
  envelope: { mode: SCRUB_MODES, 'data_secrets.reveal': new Set(['reveal_secrets']),
    'known.code.basis': new Set(['declared by code']),
    'context_capture.state': new Set(['captured', 'disabled', 'limited', 'failed', 'skipped']),
    'context_capture.identity.protocol': SCRUB_PROTOCOLS,
    'routing_alias.from': new Set(['upstream']), 'routing_alias.to': new Set(['stack']),
    'context_capture.mount.source': new Set(['contractPathPrefix', 'base-url-path', 'contract-routes']),
    'binary.body_secrets.hash': new Set(['salted-sha256']), 'binary.evidence_body_secrets.hash': new Set(['salted-sha256']) },
  usage: { mode: SCRUB_MODES },
  protocolResponse: { outcome: SCRUB_OUTCOMES },
  protocolIdentity: { protocol: SCRUB_PROTOCOLS },
  protocolEvidence: { 'response.outcome': SCRUB_OUTCOMES, 'identity.protocol': SCRUB_PROTOCOLS },
  httpEvidence: {
    'origin.initiator': new Set(EVIDENCE_INITIATORS),
    'origin.transport': new Set([...SCRUB_PROTOCOLS].map(protocol => `${TOOL_NAME}:${protocol}`)),
    'origin.scope.protocol': SCRUB_PROTOCOLS,
    'response.body_secrets.hash': new Set(['salted-sha256']),
  },
};
const GENERATED_SCRUB_IDS = {
  envelope: new Set(['evidence', 'context_capture.operation_id', 'context_capture.observation_id']),
  httpEvidence: new Set(['runId', 'page_of']), usage: new Set(['runId', 'session_id']),
};
const scrub = (s, secrets, structure, generated = {}) => {
  const forms = [...new Set([...secrets, ...(privateRequestInputs()?.values ?? [])].flatMap(value => [
    ...scrubForms(value), ...(typeof value === 'string' && value.length > 0 && value.length < 6 ? [value] : []),
  ]))].sort((a, b) => b.length - a.length);
  if (!forms.length) return s;
  // Scrub JSON string leaves and keys, preserving numeric types and syntax even
  // when a credential happens to be numeric. Non-JSON text is scrubbed directly.
  const redact = value => forms.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  let value; try { value = JSON.parse(s); } catch { return redact(s); }
  if (typeof value === 'string') return JSON.stringify(redact(value));
  const trusted = (SCRUB_STRUCTURES[structure] ?? []).map(path => path ? path.split('.') : []);
  const pending = value && typeof value === 'object' ? [{ node: value, path: [] }] : [];
  while (pending.length) {
    const { node, path } = pending.pop();
    const fixed = trusted.some(pattern => pattern.length === path.length
      && pattern.every((part, i) => part === '*' || part === path[i]));
    for (const [key, child] of Object.entries(node)) {
      const nextKey = Array.isArray(node) || fixed ? key : redact(key);
      const fieldPath = [...path, key].join('.');
      const contextPath = structure === 'protocolKnown' && /^operations\.\d+\./.test(fieldPath)
        ? fieldPath.replace(/^operations\.\d+\./, '')
        : structure === 'envelope' && fieldPath.startsWith('known.scoped.') ? fieldPath.slice('known.scoped.'.length) : null;
      const fixedValue = FIXED_SCRUB_VALUES[structure]?.[fieldPath]?.has(child)
        || contextPath === 'identity.protocol' && SCRUB_PROTOCOLS.has(child)
        || GENERATED_SCRUB_IDS[structure]?.has(fieldPath) && Object.hasOwn(generated, fieldPath) && generated[fieldPath] === child;
      let next = typeof child === 'string' && !fixedValue ? redact(child) : child;
      // These are configured labels, not fixed enums or generated IDs. If a
      // credential matches one, withhold it instead of inventing another scope.
      const scopeLabel = structure === 'envelope' && ['stack', 'environment', 'routing_alias.value', 'context_capture.identity.stack', 'context_capture.identity.environment'].includes(fieldPath)
        || structure === 'protocolIdentity' && ['stack', 'environment'].includes(fieldPath)
        || structure === 'protocolEvidence' && ['identity.stack', 'identity.environment'].includes(fieldPath)
        || ['identity.stack', 'identity.environment'].includes(contextPath);
      if (scopeLabel && typeof child === 'string' && next !== child) {
        next = null;
        Object.defineProperty(node, `${key}_withheld`, { value: true, enumerable: true, configurable: true, writable: true });
      }
      // A scrubbed file path or digest is no longer a usable pointer or hash.
      // Do not trust arbitrary save paths (or a digest-sized credential value)
      // to preserve them; explicitly withhold either changed value instead.
      const changedPointer = structure === 'envelope' && ['binary.saved_to', 'binary.sha256'].includes(fieldPath)
        || /^observations\.\d+\.evidence\.\d+\.(path|digest)$/.test(contextPath ?? '');
      if (changedPointer && typeof child === 'string' && next !== child) {
        next = null;
        Object.defineProperty(node, `${key}_withheld`, { value: true, enumerable: true, configurable: true, writable: true });
      }
      // The mount receipt has fixed keys/source labels, but its prefix comes
      // from configuration. A changed prefix is not a usable matching choice.
      if (structure === 'envelope' && fieldPath === 'context_capture.mount.pathPrefix' && typeof child === 'string' && next !== child) {
        next = null;
        Object.defineProperty(node, 'pathPrefix_withheld', { value: true, enumerable: true, configurable: true, writable: true });
      }
      // The http(s) scheme is fixed URI syntax at these client-owned paths.
      // Redact the remaining authority/path normally. A changed provider scope
      // is unknown, not a fabricated URL identifying some different provider.
      if (structure === 'httpEvidence' && ['origin.scope.provider', 'request.url'].includes(fieldPath) && typeof child === 'string') {
        const prefix = /^https?:\/\//.exec(child)?.[0];
        if (prefix) {
          const suffix = child.slice(prefix.length), redacted = redact(suffix);
          const keywordLength = prefix.indexOf(':');
          // Only matches wholly inside the fixed http(s) keyword can be
          // restored. A match touching :// or extending into the authority is
          // a complete credential match that full-string redaction must keep.
          const touchesSyntax = forms.some(secret => {
            for (let at = child.indexOf(secret); at >= 0 && at < prefix.length; at = child.indexOf(secret, at + 1))
              if (at + secret.length > keywordLength) return true;
            return false;
          });
          if (fieldPath === 'origin.scope.provider' && (touchesSyntax || suffix !== redacted)) {
            next = null;
            Object.defineProperty(node, 'provider_withheld', { value: true, enumerable: true, configurable: true, writable: true });
          } else if (!touchesSyntax) next = prefix + redacted;
        }
      }
      if (nextKey !== key) delete node[key];
      Object.defineProperty(node, nextKey, { value: next, enumerable: true, configurable: true, writable: true });
      if (next && typeof next === 'object') pending.push({ node: next, path: [...path, key] });
    }
  }
  return JSON.stringify(value);
};
export const scrubForTest = scrub;
const scrubPath = (path) => String(path ?? "").split("/").map((part) => secretIn(part) ? "{redacted}" : part).join("/");

async function logUsage(row, secrets) {
  // Private process identity survives receipt deletion; never inferred from a
  // request field, URL, caller-supplied origin or shared knowledge citation.
  row = { ...row, session_id: PROCESS_SESSION_ID };
  try {
    await withMachineStateWrite("usage", path =>
      writeOutputFile(path, `${scrub(JSON.stringify(row), secrets, 'usage', { runId: row.runId, session_id: PROCESS_SESSION_ID })}\n`, { mkdir: true, mode: 0o600, append: true }));
  } catch { /* logging must never break a request */ }
}

// Contracts follow the same actual origin/path routing as credentials. An
// unbound provider has no contract; the primary API is never its fallback.
function httpContractFor(url) {
  const target = authContextFor(url);
  const scope = httpContextScope(url, target, { baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource });
  return scope.eligible && target.httpContract ? { contract: target.httpContract, baseUrl: target.baseUrl } : null;
}

// Query parameter names written into a request path (`?a=1&b=2`). A query
// component without "=" (`?1696500000`, a hex or UUID token, `?flag`) is a
// value, not a parameter name, and is never recorded; an empty name is
// skipped. A name is decoded the way URLSearchParams decodes it; a repeated
// name counts once.
function pathQueryNames(search) {
  const names = new Set();
  for (const component of String(search ?? "").replace(/^\?/, "").split("&")) {
    if (component.indexOf("=") <= 0) continue;
    const [name] = new URLSearchParams(component).keys();
    if (name) names.add(name);
  }
  return [...names];
}

// The query names one request shape records, and how many were withheld. A
// name written into the path passes the promotion field-name scan and the
// store's own scans (shapeKeyRefusal: what contextShape drops and what the
// final scan before writing refuses); a structured `params` name passes the
// store's own scans. A refused name is dropped and counted, so a capture never
// fails because of a query name. Structured names win over written ones.
function recordedQueryNames(written, params) {
  const out = {}, refused = new Set();
  // Own data properties only: `__proto__` stays a name, never a prototype.
  const put = (name, value) => Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  for (const name of written) {
    if (fieldNameRefusal(name) || shapeKeyRefusal(name)) refused.add(name);
    else put(name, "");
  }
  for (const [name, value] of Object.entries(params ?? {})) {
    if (shapeKeyRefusal(name)) { refused.add(name); delete out[name]; }
    else put(name, value);
  }
  return { params: out, withheld: refused.size };
}

// Bounded on purpose. A 271KB deeply-nested payload has a 271KB-shaped shape,
// and describing a response must never cost as much as returning it.
const SHAPE_MAX_DEPTH = 4;
const SHAPE_MAX_KEYS = 40;
const shapeOf = (v, depth = 0) => {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v === null) return "null";
  if (typeof v !== "object") return typeof v;
  if (depth >= SHAPE_MAX_DEPTH) return "object";
  const entries = Object.entries(v);
  const kept = entries.slice(0, SHAPE_MAX_KEYS).map(([k, x]) => [k, shapeOf(x, depth + 1)]);
  if (entries.length > SHAPE_MAX_KEYS) kept.push([`…+${entries.length - SHAPE_MAX_KEYS} more keys`, "…"]);
  return Object.fromEntries(kept);
};

// Most APIs return either a bare array or a pagination envelope
// ({count, next, results: [...]}). Find the collection either way, and keep the
// envelope's sibling metadata — that is where totals and next-page links live.
const COLLECTION_KEYS = ["results", "data", "items", "records", "entries", "content"];
const collectionOf = (body) => {
  if (Array.isArray(body)) return { rows: body, meta: null, key: null };
  if (!body || typeof body !== "object") return { rows: null, meta: null, key: null };
  const keys = Object.keys(body);
  const key = COLLECTION_KEYS.find((k) => Array.isArray(body[k]))
    ?? keys.find((k) => Array.isArray(body[k]) && body[k].length && typeof body[k][0] === "object");
  if (!key) return { rows: null, meta: null, key: null };
  const meta = Object.fromEntries(
    keys.filter((k) => k !== key && typeof body[k] !== "object").map((k) => [k, body[k]]));
  return { rows: body[key], meta: Object.keys(meta).length ? meta : null, key };
};

// --- pagination detection (F4) ---------------------------------------------
// Inspect only known metadata containers, never arbitrary row objects. Many
// APIs put pagination beside the collection in `pagination` or `meta`.
const paginationObjects = (body) => {
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!object(body)) return [];
  return [body, body.pagination, body.paging, body.meta, body.meta?.pagination]
    .filter(object);
};

// The response chooses the style: explicit next-token, Link rel=next, then
// page/per_page or offset/limit. A more-rows signal without a usable next step
// is an incomplete collection, not evidence of exhaustion.
function nextPageOf(res, body, rowsLen) {
  const objects = paginationObjects(body);
  const moreFlags = objects.flatMap((obj) => [obj.has_more, obj.hasMore])
    .filter((v) => typeof v === "boolean");
  const hasMore = moreFlags[0];
  const incomplete = (style, reason, note) => ({ style, stopped_early: reason, note });
  const cursorKeys = ["next_cursor", "next_page_token", "next_token", "next"];
  const link = res.headers.get("link");
  const nextLink = link && /<([^>]+)>\s*;[^,]*\brel="?next"?/i.exec(link);
  // Check explicit statements together before choosing a navigation style.
  // A null cursor cannot overrule a total that still promises more rows, and
  // one metadata container cannot silently overrule another's terminal flag.
  const moreEvidence = [...moreFlags, ...(nextLink ? [true] : [])];
  for (const obj of objects) {
    const num = (k) => Number.isSafeInteger(obj[k]) && obj[k] >= 0 ? obj[k] : null;
    for (const key of cursorKeys) {
      if (!(key in obj)) continue;
      const value = obj[key];
      if (value === null || value === undefined || value === "" || value === false) moreEvidence.push(false);
      else if (typeof value === "string" || typeof value === "number") moreEvidence.push(true);
    }
    const total = num("total") ?? num("total_count") ?? num("count");
    const page = num("page"), perPage = num("per_page") ?? num("page_size"), totalPages = num("total_pages");
    if (page !== null && page > 0) {
      if (totalPages !== null) moreEvidence.push(page < totalPages);
      if (total !== null && perPage !== null && perPage > 0) moreEvidence.push(page * perPage < total);
    }
    const offset = num("offset"), limit = num("limit");
    if (offset !== null && limit !== null && limit > 0 && total !== null)
      moreEvidence.push(offset + rowsLen < total);
  }
  if (new Set(moreEvidence).size > 1)
    return incomplete(null, "inconsistent_pagination", "The response contains conflicting terminal and more-rows pagination signals.");
  for (const obj of objects) {
    for (const k of cursorKeys) {
      if (!(k in obj)) continue;
      const v = obj[k];
      // The field being PRESENT but empty is the API saying "last page".
      if (v === null || v === undefined || v === "" || v === false)
        return { style: "cursor", done: true };
      if (typeof v === "string" && /^(https?:\/\/|\/)/.test(v)) return { style: "cursor", url: v };
      if (typeof v === "string" || typeof v === "number")
        return { style: "cursor", param: k === "next_page_token" ? "page_token" : "cursor", value: String(v) };
      return incomplete("cursor", "unsupported_pagination", "The response's next token is not a supported string or number.");
    }
  }
  if (nextLink) return { style: "link", url: nextLink[1] };
  for (const obj of objects) {
    const num = (k) => Number.isSafeInteger(obj[k]) && obj[k] >= 0 ? obj[k] : null;
    const total = num("total") ?? num("total_count") ?? num("count");
    const page = num("page"), perPage = num("per_page") ?? num("page_size"), totalPages = num("total_pages");
    if (page !== null && page > 0 && ((perPage !== null && perPage > 0) || totalPages !== null)) {
      const atEnd = (totalPages !== null && page >= totalPages)
        || (total !== null && page * (perPage ?? rowsLen) >= total);
      const moreExpected = hasMore === true || (totalPages !== null && page < totalPages)
        || (total !== null && perPage !== null && page * perPage < total);
      if (moreExpected && rowsLen === 0)
        return incomplete("page", "empty_page", "An empty page was returned while pagination still indicates more rows.");
      const done = hasMore === false || atEnd || (!moreExpected && (rowsLen === 0 || (perPage !== null && rowsLen < perPage)));
      return done ? { style: "page", done: true } : { style: "page", param: "page", value: String(page + 1) };
    }
    const offset = num("offset"), limit = num("limit");
    if (offset !== null && limit !== null && limit > 0) {
      const atEnd = total !== null && offset + rowsLen >= total;
      const moreExpected = hasMore === true || (total !== null && !atEnd);
      if (moreExpected && rowsLen === 0)
        return incomplete("offset", "empty_page", "An empty page was returned while pagination still indicates more rows.");
      const done = hasMore === false || atEnd || (!moreExpected && (rowsLen === 0 || rowsLen < limit));
      // Carry limit forward explicitly so the page size cannot drift when the
      // caller relied on the server's default.
      return done ? { style: "offset", done: true }
        : { style: "offset", param: "offset", value: String(offset + rowsLen), keep: { limit: String(limit) } };
    }
  }
  if (hasMore === false) return { style: null, done: true };
  const standaloneTotal = objects.map((obj) => obj.total ?? obj.total_count)
    .find((value) => Number.isSafeInteger(value) && value >= 0);
  if (hasMore === undefined && standaloneTotal !== undefined && standaloneTotal <= rowsLen
    && !objects.some((obj) => ["page", "per_page", "page_size", "total_pages", "offset", "limit"].some((key) => key in obj)))
    return { style: null, done: true };
  if (hasMore === true || objects.some((obj) => ["page", "per_page", "page_size", "total_pages", "offset", "limit", "total", "total_count", "has_more", "hasMore"]
    .some((key) => key in obj)))
    return incomplete(null, "unsupported_pagination", "Pagination metadata is present, but no supported next request or terminal signal can be determined.");
  return null;
}

// Distinct values of low-cardinality string fields — the thing an agent would
// otherwise burn a full page of rows to infer.
// Timestamps, ids, urls, and free text are never enums. Without excluding them a
// small page yields "facets" full of distinct created_at values, which is noise
// dressed as insight.
const NOT_A_FACET_KEY = /(^|_)(id|at|on|url|uri|href|slug|token|hash|email|phone)$|^(created|updated|deleted|title|name|description|notes|summary|message|content|body)/i;
const LOOKS_TEMPORAL = /^\d{4}-\d{2}-\d{2}([ T]|$)|^\d{10,13}$/;

const facetsOf = (rows) => {
  if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== "object") return undefined;
  const out = {};
  for (const key of Object.keys(rows[0])) {
    if (NOT_A_FACET_KEY.test(key)) continue;
    const vals = rows.map((r) => r?.[key]).filter((v) => typeof v === "string");
    if (vals.length !== rows.length) continue;
    if (vals.some((v) => LOOKS_TEMPORAL.test(v) || v.length > 40)) continue;
    const distinct = [...new Set(vals)];
    // A "facet" where every row differs is an identifier, not a category.
    if (distinct.length > 1 && distinct.length <= 8 && distinct.length < rows.length)
      out[key] = distinct;
  }
  return Object.keys(out).length ? out : undefined;
};

// Public entry point. Deduplicates identical in-flight calls, then delegates.
import {
  ENVELOPE_VERSION, OPERATORS, atPath, runAssertions, truncateValue,
} from "./assertions.mjs";
import { parseCurl, SECRET_HEADERS, CREDENTIAL_SHAPED_HEADER, SECRET_PARAMS } from "./curl.mjs";

// One canonical error envelope. Every error path returns the same stable keys as a
// success, so the tool's headline promise — an agent never inspects a response
// to learn how to read it — holds on failures too. Two paths violated it: the
// batch runner's UNRESOLVED_PLACEHOLDER carried the legacy flat shape, and
// a malformed API_AUTH returned a bare `{ error }` with no envelope at all.
function errorEnvelope({ id = null, code, message, next, kind, mode = "error", status = null, error, known = null }) {
  const result = { v: ENVELOPE_VERSION, id, status, ok: false, mode, ...routingFields(),
    assertions: null, data: null, discovery: null, headers: null,
    contract_delta: null, rate_limit: null, environment: clientRuntime().config.name ?? null, known,
    error: error ?? { ...(kind ? { kind } : {}), code, message, ...(next ? { next } : {}) },
    evidence: null };
  if (tokens(JSON.stringify(result)) > clientRuntime().budget) omitSavedRequests(result.known);
  if (result.known?.code && tokens(JSON.stringify(result)) > clientRuntime().budget) omitKnownCode(result.known);
  if (tokens(JSON.stringify(result)) > clientRuntime().budget) compactKnownMetadata(result.known);
  if (tokens(JSON.stringify(result)) > clientRuntime().budget) omitKnownNoteProjection(result.known);
  if (result.known?.account_facts) {
    const fits = () => tokens(JSON.stringify(result)) <= clientRuntime().budget;
    while (!fits() && result.known.account_facts.records?.length)
      Object.assign(result.known, accountFactReceiptAfterTrim(result.known, result.known.account_facts.records.length - 1));
    if (!fits()) { result.budget_min = 0; for (let i = 0; i < 4; i++) result.budget_min = tokens(JSON.stringify(result)); }
  }
  const present = () => JSON.parse(scrub(JSON.stringify(result), configuredCredentialSecrets(), 'envelope'));
  let clean = present();
  if (tokens(JSON.stringify(clean)) > clientRuntime().budget) {
    // Compact the original projection, then scrub its values again. Never
    // reconstruct unmasked review text after the credential boundary.
    compactKnownMetadata(result.known);
    clean = present();
    if (tokens(JSON.stringify(clean)) > clientRuntime().budget) {
      omitKnownNoteProjection(result.known);
      clean = present();
    }
  }
  measureSavedRequests(clean.known);
  if (tokens(JSON.stringify(clean)) > clientRuntime().budget) omitSavedRequests(clean.known);
  measureKnownCode(clean.known?.code);
  // Credential masking can expand file names. Budget the presented locations,
  // not their pre-scrub spelling; a refusal must not bypass the same bound.
  if (tokens(JSON.stringify(clean)) > clientRuntime().budget) {
    if (clean.known?.code) omitKnownCode(clean.known);
    if (tokens(JSON.stringify(clean)) > clientRuntime().budget) {
      clean.budget_min = 0;
      for (let i = 0; i < 4; i++) clean.budget_min = tokens(JSON.stringify(clean));
    }
  }
  return clean;
}

// Direct request arguments must follow the same credential boundary as pasted
// curl commands and committed suites. Auth belongs in an environment reference;
// accepting a literal here would both put it on the wire and persist it in the
// complete evidence record. Match names, never values, so the refusal itself
// cannot echo a secret back into the agent transcript.
function literalCredentialError(headers, params, url) {
  const secretHeaders = Object.keys(headers ?? {})
    .filter((name) => SECRET_HEADERS.test(name) || CREDENTIAL_SHAPED_HEADER.test(name));
  const secretParams = [...new Set([
    ...Object.keys(params ?? {}),
    ...[...url.searchParams.keys()],
  ].filter((name) => SECRET_PARAMS.test(name)))];
  const hasUserinfo = Boolean(url.username || url.password);
  if (!secretHeaders.length && !secretParams.length && !hasUserinfo) return null;
  return {
    kind: "policy", code: "CREDENTIAL_IN_REQUEST",
    message: "The request contains a literal credential location, so it was not sent.",
    details: {
      ...(secretHeaders.length ? { headers: secretHeaders } : {}),
      ...(secretParams.length ? { params: secretParams } : {}),
      ...(hasUserinfo ? { url_userinfo: true } : {}),
    },
    next: "Configure authentication with API_AUTH or a host auth environment reference, then omit the literal credential from the request.",
  };
}

// A plausible but unsupported routing field must never become a successful
// request to the default API. Return field names only, never their values.
function unsupportedRoutingError(args) {
  const fields = ["host", "baseUrl", "base_url", "url", "origin"]
    .filter(key => args && Object.hasOwn(args, key));
  return fields.length ? { kind: "input", code: "REQUEST_ROUTING_FIELD_UNSUPPORTED",
    message: `Unsupported request routing field${fields.length > 1 ? "s" : ""}: ${fields.join(", ")}. No requests executed.`,
    details: { fields },
    next: `Use upstream:"<name>" for a named entry in ${LAYOUT.environments} hosts, and path:"/..." for the operation. Use path for an explicitly configured full URL; do not use host, baseUrl, base_url, url, or origin.` } : null;
}

// Doctor exercises this client without silently acquiring credentials or
// following server-directed requests. The private Symbol cannot be supplied by
// a JSON request or MCP input; ordinary request behavior stays unchanged.
const READ_PROBE = Symbol("read-probe");
const MAP_READ = Symbol("map-read");
const REQUEST_ORIGIN = Symbol("request-origin");
// A suite reference is a requirement, never authority to select another secret.
const REQUIRED_STEP_AUTH = Symbol("required-step-auth");
const FEEDBACK_CONSENT = Symbol('feedback-consent');
function sameAuthReference(left, right) {
  const a = parseAuthReference(left), b = parseAuthReference(right);
  if (!a || !b || a.scheme !== b.scheme) return false;
  if (a.scheme === 'header') return a.name.toLowerCase() === b.name.toLowerCase() && a.envVar === b.envVar;
  if (a.scheme === 'query') return a.param === b.param && a.envVar === b.envVar;
  if (a.scheme === 'oauth') return a.clientIdEnv === b.clientIdEnv && a.clientSecretEnv === b.clientSecretEnv;
  if (a.scheme === 'basic') return a.usernameEnv === b.usernameEnv && a.passwordEnv === b.passwordEnv;
  return a.envVar === b.envVar;
}
const PROBE_TRANSPORT_CODES = new Set(["REQUEST_TIMEOUT", "TRANSPORT_FAILED", "ECONNREFUSED",
  "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
export async function apiReadProbe({ path, method = "HEAD", onRequest, targetSource = "configured", expect }, internal) {
  if (!["HEAD", "GET"].includes(method) || typeof onRequest !== "function"
    || !["default", "override", "configured"].includes(targetSource))
    throw new TypeError("A read probe requires HEAD/GET and a pre-request announcement.");
  const probe = { onRequest, attempted: false, transportFailed: false, targetSource };
  // Only this private, unauthenticated probe can target an unconfigured origin.
  // Never add it to ORIGIN_AUTH or alter CONFIG for ordinary API requests.
  if (targetSource !== "configured") {
    let url;
    try {
      if (typeof path !== "string" || path.length > 2048 || /[\x00-\x20\x7f-\x9f]/.test(path)) throw new Error();
      url = new URL(path);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      return { result: errorEnvelope({ mode: "refused", code: "URL_INVALID", message: "A probe needs a bounded absolute HTTP(S) URL." }), attempted: false, transportFailed: false };
    }
    probe.target = { url, context: null };
  }
  try {
    const result = await apiRequest({ method, path, expect, capture_context: false, [READ_PROBE]: probe },
      { initiator: evidenceInitiator(internal, 'library.apiReadProbe') });
    return { result, attempted: probe.attempted, transportFailed: false, response: probe.response };
  } catch (error) {
    // Never copy native diagnostics: parser errors can contain response bytes.
    const code = PROBE_TRANSPORT_CODES.has(error?.code) || error?.code === "RESPONSE_OVERSIZED"
      ? error.code : "CLIENT_PROBE_FAILED";
    return { error: { code }, attempted: probe.attempted,
      transportFailed: probe.transportFailed && PROBE_TRANSPORT_CODES.has(code) };
  }
}

// Internal CLI learn adapter. All transport/auth/header handling and assertion
// execution stay in apiRequest. The full parsed body is transient promotion
// input, never the budgeted envelope's projection/summary. Do not expose it as
// a new MCP input or output. Shared capture is off because learn owns one
// snapshot-guarded knowledge write; private request evidence stays on.
export async function apiLearnRead({ method, path, onAttempt }) {
  if (!["GET", "HEAD"].includes(method)) throw new TypeError("learn accepts GET/HEAD only");
  const packet = await apiRequest({ method, path, capture_context: false,
    expect: [{ status: true, gt: 199, lt: 300 }], _withBody: true, _onAttempt: onAttempt }, { initiator: 'cli.learn' });
  // A refusal can precede body acquisition and return a plain envelope.
  const result = packet.result ?? packet;
  const drift = result.contract_delta ?? [];
  const redirect = drift.find(item => item.kind === "redirect");
  const status = redirect?.status ?? result.status;
  const verified = !redirect && result.ok === true && Number.isInteger(status)
    && status >= 200 && status < 300 && result.assertions?.passed > 0
    && result.assertions.failed === 0 && typeof result.evidence === "string";
  return { result, status, drift, verified,
    // A followed redirect's response belongs to another operation. Likewise,
    // an error envelope must never replace an operation's successful shape.
    body: verified ? packet.body : undefined };
}

// Internal visualization adapter. Its admission plan has already announced all
// targets. Keep normal authentication and evidence, but bound each declared
// read to one attempt; redirects/retries and OAuth grants need an explicit
// request instead. A legacy estate must bind each surface's own runtime too.
export async function apiMapRead({ root, scope, config, method, path, onAttempt, command }) {
  if (!["GET", "HEAD"].includes(method) || !["map", "view"].includes(command))
    throw new TypeError("A visualization probe requires a declared safe read.");
  const selected = scope ?? { root, config: config ?? resolveConfig(root) };
  if (String(selected.config.auth ?? '').startsWith('oauth:'))
    return { error: { code: 'MAP_OAUTH_REQUIRES_EXPLICIT_REQUEST' } };
  return withStackScope(selected, () => clientRuntimes.run(createClientRuntime(selected), () =>
    apiRequestBound({ method, path, capture_context: true, expect: [{ status: true, gt: 199, lt: 300 }],
      _onAttempt: onAttempt, [MAP_READ]: true }, { initiator: `cli.${command}` })));
}

const routingFields = () => clientRuntime().stack ? {
  stack: clientRuntime().stack,
  ...(clientRuntime().alias ? { routing_alias: clientRuntime().alias } : {}),
} : {};

// Pre-dispatch refusals have no applied-auth snapshot yet. Read only the active
// runtime's provider-local references so configured labels cannot echo a value
// that is missing its partner or was rejected before dispatch. Never send it.
function configuredCredentialSecrets() {
  const secrets = [];
  for (const contexts of clientRuntime().originAuth.values()) for (const context of contexts) {
    const vars = authEnvVars(context.auth);
    if (!Array.isArray(vars) || !vars.length) continue;
    const environment = credentialEnvironment(context.credentialEnvFiles);
    secrets.push(...vars.map(name => environment[name]).filter(value => typeof value === 'string' && value));
    const auth = parseAuthReference(context.auth);
    if (auth?.scheme === 'basic' && environment[auth.usernameEnv] && environment[auth.passwordEnv]) {
      const combined = `${environment[auth.usernameEnv]}:${environment[auth.passwordEnv]}`;
      const encoded = Buffer.from(combined, 'utf8').toString('base64');
      secrets.push(combined, encoded, `Basic ${encoded}`);
    }
  }
  return secrets;
}

// Resolve before constructing any URL, applying authentication, or touching a
// request lane. Runtime tables and context scope are carried by ALS across
// awaits; parallel stacks never share a mutable current configuration.
function requestStackScope(args) {
  if (args?.[READ_PROBE]?.target) return null;
  let path = args.path ?? '';
  if (args.curl) {
    const parsed = parseCurl(args.curl);
    // Parser refusals must keep their exact credential/input reason even when
    // a multi-stack repository has no relative default.
    if (parsed.error) return null;
    path = `${parsed.origin}${parsed.request.path}`;
  }
  const inherited = currentStackScope();
  const explicitStack = args.stack ?? args.upstream;
  const sameStack = explicitStack === undefined || explicitStack === inherited?.stack;
  return resolveStack(inherited?.root ?? DEFAULT_CONTEXT_ROOT, {
    stack: args.stack ?? (args.upstream === undefined ? inherited?.stack : undefined),
    upstream: args.upstream, path,
    environment: args.environment ?? (sameStack ? inherited?.config.name : undefined),
  });
}
const stackRoutingError = error => ({ kind: 'config', code: error.code ?? 'STACK_INVALID', message: error.message,
  ...(error.details ? { details: error.details } : {}), ...(error.next ? { next: error.next } : {}),
});
async function withRequestRuntime(args, action) {
  let scope;
  try { scope = requestStackScope(args); }
  catch (error) { return errorEnvelope({ id: args.id ?? null, mode: 'refused', error: stackRoutingError(error) }); }
  if (!scope) return withCodeLocations(clientRuntime().root, () => action(args)); // Legacy requests run; capture applies the R7 read-only boundary.
  const selected = { ...args, stack: scope.stack, environment: scope.config.name };
  // On explicit stacks upstream is the one-release alias, not the old hosts map.
  delete selected.upstream;
  return withStackScope(scope, () => {
    // Readers bind their file path at construction, so construct them only
    // after the stack scope is active.
    const runtime = createClientRuntime(scope);
    if (scope.alias) runtime.alias = { ...scope.alias, value: args.upstream };
    // Each exit owns its routing fields before scrub and budget measurement.
    // Appending them here would reintroduce withheld credential-matching names.
    return clientRuntimes.run(runtime, () => withCodeLocations(runtime.root, () => action(selected)));
  });
}

// The session ledger's private outcome record (lib/session-ledger-record.mjs):
// written beside the run files when a batch finishes or a top-level single
// call ends without evidence. Best effort; it never changes the envelope.
// It goes only into an evidence directory that already exists (the named
// stack's, else the default one), protected exactly as run files are: a
// refusal never creates an evidence folder or a project layout from nothing.
const LEDGER_NESTED = Symbol('ledger-nested');
function recordEnvelopeOutcome(record) {
  if (!record) return;
  try {
    const stacks = [...new Set([record.stack, ...record.steps.map(step => step.stack)].filter(Boolean))];
    const dir = [...stacks.map(name => resolve(clientRuntime().root, LAYOUT.evidence, name)), clientRuntime().evidence]
      .find(candidate => { try { return lstatSync(safeOutputPath(candidate, { directory: true })).isDirectory(); } catch { return false; } });
    if (!dir) return;
    protectEvidence(dir);
    writeOutputFileAtomic(join(dir, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
  } catch { /* the ledger must never break or alter a request */ }
}

export async function apiRequest(args, internal) {
  if (internal?.[LEDGER_NESTED]) return apiRequestUnrecorded(args, internal);
  const startedAt = new Date().toISOString();
  const result = await apiRequestUnrecorded(args, internal);
  recordEnvelopeOutcome(singleOutcomeRecord(args, result, { initiator: evidenceInitiator(internal), startedAt }));
  return result;
}

async function apiRequestUnrecorded(args, internal) {
  if (args.reveal_secrets !== undefined && typeof args.reveal_secrets !== 'boolean')
    return errorEnvelope({ id: args.id ?? null, mode: 'refused', code: 'REVEAL_SECRETS_INVALID',
      message: 'reveal_secrets must be a boolean. No request was sent.' });
  if (Object.hasOwn(args, 'finally') || Object.hasOwn(args, 'reveal_captures'))
    return errorEnvelope({ id: args.id ?? null, mode: 'refused', code: 'BATCH_ENVELOPE_REQUIRED',
      message: 'finally and reveal_captures require a requests batch envelope. No request was sent.' });
  const routingError = unsupportedRoutingError(args);
  if (routingError) return errorEnvelope({ id: args.id ?? null, mode: 'refused', error: routingError });
  return withRequestRuntime(args, selected => apiRequestBound(selected, internal));
}

async function apiRequestBound(args, internal) {
  // JSON/MCP inputs cannot provide this private channel. Never copy origin
  // metadata from a public request field, including a caller-supplied origin.
  const initiator = evidenceInitiator(internal);
  args = { ...args, [REQUEST_ORIGIN]: initiator,
    [FEEDBACK_CONSENT]: internal?.feedback,
    ...(internal?.requiredAuth !== undefined ? { [REQUIRED_STEP_AUTH]: internal.requiredAuth } : {}) };
  const routingError = unsupportedRoutingError(args);
  if (routingError) return errorEnvelope({ id: args.id ?? null, mode: "refused", error: routingError });
  if ((!args.protocol || args.protocol === "http") && ["graphql", "rpc", "grpc", "websocket"].some(key => args[key] !== undefined))
    return errorEnvelope({ id: args.id ?? null, mode: "refused", code: "PROTOCOL_REQUIRED",
      message: "Set protocol explicitly when using a protocol-specific input object." });
  if (args.protocol && args.protocol !== "http") {
    if (isBuiltinStack(clientRuntime().stack)) return errorEnvelope({ code: 'FEEDBACK_REQUEST_INVALID',
      message: 'The packaged feedback stack supports only its declared HTTP operations.', mode: 'refused' });
    const { protocolRequest } = await import("./protocol-client.mjs");
    return protocolRequest(args, {
      root: clientRuntime().root, stack: clientRuntime().stack, routingFields: routingFields(), environment: clientRuntime().config.name ?? "default", timeoutMs: clientRuntime().timeoutMs, budget: clientRuntime().budget,
      contextEnabled: process.env.API_CONTEXT_OFF !== "1",
      stackKnown: (known, identity, target) => withAccountFacts(prependStackFacts(known, clientRuntime().contextReader?.current()?.ctx,
        { stack: clientRuntime().stack, operation: identity.operation }), target.url),
      prepareTarget: prepareProtocolTarget, errorEnvelope,
      refusedKnown: target => process.env.API_CONTEXT_OFF === '1' || !target.url ? null : withAccountFacts(null, target.url),
      scrub: (value, secrets, structure) => JSON.parse(scrub(JSON.stringify(value), secrets, structure)),
      withSlot: (url, fn, signal) => withHostSlot(url.host, fn, signal),
      writeEvidence: record => {
        safeOutputPath(join(clientRuntime().evidence, ".gitignore"));
        mkdirSync(clientRuntime().evidence, { recursive: true, mode: 0o700 });
        protectEvidence(clientRuntime().evidence);
        const runId = `run-${Date.now()}-${randomUUID()}`;
        const file = join(clientRuntime().evidence, `${runId}.json`);
        // Run files appear whole: readers that list evidence never see one half written.
        // A failed assertion can repeat a response value beside the body.
        // Protect both representations before the same record reaches disk.
        const protectedResponse = sanitizeEvidenceBody({ body: record.response?.body, assertions: record.assertions });
        const parts = typeof protectedResponse.body === 'string'
          ? { body: protectedResponse.body, assertions: record.assertions ? { passed: record.assertions.passed,
            failed: record.assertions.failed, failures: [], details_withheld: protectedResponse.body } : record.assertions }
          : protectedResponse.body;
        const response = { ...record.response, body: parts.body, body_secrets: protectedResponse.body_secrets };
        writeOutputFileAtomic(file, JSON.stringify({ ...record, response, assertions: parts.assertions,
          runId, origin: requestEvidenceOrigin(initiator, args.protocol, record.identity) }), { mkdir: true, mode: 0o600 });
        return { id: runId, path: file };
      },
    });
  }
  if (args.curl) {
    const { request, origin, warnings, error } = parseCurl(args.curl);
    if (error) return errorEnvelope({ id: args.id ?? null, mode:'refused', error });
    // Auth is host-scoped. A pasted curl targeting a CONFIGURED origin (base or
    // hosts map) routes there, carrying that origin's own credential; any other
    // origin is refused rather than silently retargeted, because sending the
    // base environment's credential to a different origin would leak it.
    if (!clientRuntime().originAuth.has(origin))
      return errorEnvelope({ id: args.id ?? null, mode:'refused', error: { kind: "policy", code: "CURL_ORIGIN_MISMATCH",
          message: `The command targets ${origin} but this client is configured for ${clientRuntime().base}.`,
          details: { curl_origin: origin, configured: clientRuntime().base, environment: clientRuntime().config.name ?? null },
          next: "Point API_BASE_URL or API_ENV at that origin, or declare it under \"hosts\" in " +
                `${LAYOUT.environments} with its own auth reference. Credentials are host-scoped ` +
                "and are never sent to another host." },
        });
    // The pasted URL is COMPLETE: pass it through whole and let resolveTarget's
    // full-URL branch use it as-is. Reducing it to a pathname and re-prefixing
    // the upstream's baseUrl doubled any base path the URL already carried
    // (…/v1/v1/…), and keying the routing decision on an exact BASE string
    // match refused the base itself whenever API_BASE_URL carried a path.
    const merged = { ...request,
      path: `${origin}${request.path}`,
      ...Object.fromEntries(
        Object.entries(args).filter(([k, v]) => k !== "curl" && v !== undefined)) };
    const result = await apiRequest(merged, { initiator, [LEDGER_NESTED]: true });
    return warnings.length ? { ...result, curl_warnings: warnings } : result;
  }
  // Do this before in-flight GET coalescing. Otherwise a credential-bearing
  // call could share an already-running safe request with the same path and
  // appear to succeed without ever crossing the refusal boundary.
  const method = (args.method ?? "GET").toUpperCase();
  const preflightTarget = args[READ_PROBE]?.target ?? resolveTarget(args.path, args.upstream);
  if (!preflightTarget.error) {
    const literalCredential = literalCredentialError(
      args.headers, args.params, preflightTarget.url);
    if (literalCredential)
      return errorEnvelope({ id: args.id ?? null, mode: "refused",
        known: args[READ_PROBE] ? null : knownFor(method, preflightTarget.url), error: literalCredential });
  }
  const bodyText = args.body === undefined ? ""
    : typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  const key = args.idempotency_key;
  // File or Basic credentials may rotate while the same read is in flight.
  // Imported auth requirements also need their own per-attempt validation.
  // Each caller must reach dispatch instead of borrowing an older response.
  const fileCredentials = preflightTarget.context?.auth && preflightTarget.context?.credentialEnvFiles?.length;
  const basicCredentials = parseAuthReference(preflightTarget.context?.auth)?.scheme === 'basic';
  if (args[READ_PROBE] || args[REQUIRED_STEP_AUTH] !== undefined || privateRequestInputs() || fileCredentials || basicCredentials
      || args.files !== undefined || containsBodyFileReference(args.body) || !mayCoalesce(method, key)) return apiRequestOnce(args);

  // The upstream is part of identity: GET /same on host A and GET /same on
  // host B are different requests, and coalescing them would answer one host's
  // call with the other host's data.
  const fp = fingerprint(method, `${initiator}|${args.upstream ?? ""}|${args.path}|${JSON.stringify(args.params ?? {})}|${JSON.stringify(args.expect ?? null)}|${JSON.stringify(args.fields ?? null)}|${JSON.stringify(args.paginate ?? null)}|${args.capture_context ?? 'auto'}|${args.reveal_secrets === true}`, bodyText, key);
  const existing = inFlight.get(fp);
  if (existing) return existing.then((r) => ({ ...r, coalesced: true }));

  const promise = apiRequestOnce(args).finally(() => inFlight.delete(fp));
  inFlight.set(fp, promise);
  return promise;
}

// Reuse the exact target/auth/policy boundary for every transport. A protocol's
// effect is parsed for queries/mutations or explicitly declared for a stream;
// unknown effects take the write boundary. A declaration is not verification.
async function prepareProtocolTarget(args, { effect, signal }) {
  if (clientRuntime().config.problems.length) return { error: { kind: "config", ...clientRuntime().config.problems[0] } };
  const target = resolveTarget(args.path ?? "", args.upstream);
  if (target.error) return target;
  const { url } = target;
  if (isBuiltinFeedbackTarget(url.href))
    return { error: { code: 'FEEDBACK_REQUEST_INVALID', message: 'The feedback service supports only its declared HTTP operations through the explicit send flow.' } };
  if (!["http:", "https:"].includes(url.protocol))
    return { error: { code: "PROTOCOL_URL_INVALID", message: "Configure the service authority with an http or https base URL." } };
  const credential = literalCredentialError(args.headers, args.params, url);
  if (credential) return { error: credential };
  for (const [key, value] of Object.entries(args.params ?? {})) url.searchParams.set(key, String(value));
  const ctx = target.context ?? authContextFor(url);
  const guard = productionGuard(ctx ? { name: ctx.name ?? clientRuntime().config.name ?? "default", baseUrl: ctx.baseUrl,
    production: Boolean(ctx.production) } : clientRuntime().config, effect === "read" ? "GET" : "POST");
  if (guard) return { error: guard };
  const init = { headers: {} };
  for (const [key, value] of Object.entries(authContextFor(url)?.headers ?? {})) init.headers[key.toLowerCase()] = String(value);
  for (const [key, value] of Object.entries(args.headers ?? {})) init.headers[key.toLowerCase()] = String(value);
  const jar = cookieHeaderFor(url);
  if (jar && !init.headers.cookie) init.headers.cookie = jar;
  const auth = await applyAuth(url, init, { signal });
  // Protocol writes and streams must not silently continue with missing auth.
  if (auth.error) return { error: auth.error, url };
  return { url, headers: init.headers, secrets: [...auth.secrets, ...cookieValuesFor(url)],
    provider: ctx?.baseUrl ?? url.origin, environment: clientRuntime().config.name ?? "default", stack: clientRuntime().stack ?? undefined };
}

function httpEvidenceScope(url, method) {
  const target = authContextFor(url);
  const identity = httpContextIdentity(url, target, { method,
    baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource, environment: clientRuntime().config.name ?? 'default', stack: clientRuntime().stack ?? undefined });
  // Without a declared route, do not promote a concrete path (which can
  // contain a person's identifier) into shared note provenance.
  return identity ?? { provider: target?.baseUrl ?? null, environment: clientRuntime().config.name ?? 'default', stack: clientRuntime().stack ?? undefined };
}

async function apiRequestOnce(args) {
  // One deadline covers auth, rate-limit waits, redirects, retries and pages.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args[READ_PROBE] ? 3000 : clientRuntime().timeoutMs);
  try {
    const target = args[READ_PROBE]?.target ?? resolveTarget(args.path, args.upstream);
    if (isBuiltinStack(clientRuntime().stack) || !target.error && isBuiltinFeedbackTarget(target.url.href))
      return await feedbackRequestOnce(args, target, controller.signal);
    return await apiRequestOnceInner(args, controller.signal);
  }
  catch (error) {
    if (['IMPORTED_AUTH_ABSENCE_REQUIRED', 'IMPORTED_AUTH_BINDING_REQUIRED', 'IMPORTED_AUTH_VALUE_REQUIRED'].includes(error?.code))
      return errorEnvelope({ id: args.id ?? null, mode: 'refused', error: { kind: 'config', code: error.code,
        message: 'The imported authentication requirement is not satisfied for this request attempt; no additional request was sent.',
        next: 'Review the selected host binding and session credentials before retrying this suite step.' } });
    if (error?.constructor === Error && typeof error.code === "string") throw error;
    throw normalizeNetworkError(error, controller.signal);
  } finally { clearTimeout(timer); controller.abort(); }
}

// This is still the repository's API client, including known context, asserted
// results and private evidence. Feedback has a deliberately smaller transport
// surface: no ambient credentials, cookies, redirects, retries, capture, drift
// projection or server-controlled prose. Keep it below the batch entry point.
async function feedbackRequestOnce(args, target, signal) {
  const url = target.url, method = String(args.method ?? 'GET').toUpperCase();
  const known = url && knownFor(method, url);
  const refuse = (code, message, details) => errorEnvelope({ id: args.id ?? null, known, mode: 'refused',
    error: { kind: 'policy', code, message, ...(details ? { details } : {}) } });
  if (target.error || !isBuiltinStack(clientRuntime().stack) || !url
      || url.username || url.password || url.search || url.hash
      || !(method === 'POST' && url.href === `${FEEDBACK_BASE_URL}/feedback`
        || method === 'GET' && url.href === `${FEEDBACK_BASE_URL}/feedback/schema`)
      || ['headers', 'params', 'paginate', 'save_to', 'files', 'body_type', 'idempotency_key'].some(key => args[key] !== undefined)
      || containsBodyFileReference(args.body)
      || method === 'GET' && args.body !== undefined)
    return refuse('FEEDBACK_REQUEST_INVALID', 'Use only the declared feedback operation with no request overrides. Nothing was sent.');
  let prepared;
  try {
    if (method === 'POST') {
      let payload = args.body;
      if (typeof payload === 'string') {
        if (Buffer.byteLength(payload) > 32768) return refuse('FEEDBACK_BODY_TOO_LARGE', 'The feedback body exceeds 32 KiB; nothing was sent.');
        try { payload = JSON.parse(payload); }
        catch { return refuse('FEEDBACK_PAYLOAD_INVALID', 'Feedback must match the shipped JSON schema; nothing was sent.'); }
      }
      if (containsBodyFileReference(payload)) return refuse('FEEDBACK_REQUEST_INVALID', 'Feedback cannot read body files. Nothing was sent.');
      prepared = await prepareFeedbackSend(clientRuntime().root, payload, args[FEEDBACK_CONSENT]);
    }
  } catch (error) {
    return refuse(error.code ?? 'FEEDBACK_PREPARATION_FAILED',
      error.code?.startsWith('FEEDBACK_') || error.code === 'OUTPUT_UNSAFE_PATH' ? error.message : 'The local feedback receipt could not be prepared; nothing was sent.', error.details);
  }
  // Check every private output destination before crossing the wire.
  safeOutputPath(join(clientRuntime().evidence, '.gitignore'));
  mkdirSync(clientRuntime().evidence, { recursive: true, mode: 0o700 });
  protectEvidence(clientRuntime().evidence);
  const runId = `run-${randomUUID()}`, evidenceFile = join(clientRuntime().evidence, `${runId}.json`);
  safeOutputPath(evidenceFile);
  const started = Date.now();
  let status = null, responseBytes = 0, value = null, failure = null, retry = null;
  try {
    signal.throwIfAborted();
    args._onAttempt?.();
    const res = await fetch(url, { method, headers: method === 'POST' ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      ...(prepared ? { body: prepared.bytes } : {}), redirect: 'manual', signal });
    status = res.status;
    const chunks = [], reader = res.body?.getReader(), limit = method === 'GET' ? 32768 : 1024;
    try {
      if (reader) for (;;) {
        const { done, value: bytes } = await reader.read();
        if (done) break;
        responseBytes += bytes.byteLength;
        if (responseBytes > limit) throw Object.assign(new Error('The feedback response exceeded its fixed-shape bound; its body was withheld.'), { code: 'FEEDBACK_RESPONSE_INVALID' });
        chunks.push(Buffer.from(bytes));
      }
    } finally { try { await reader?.cancel(); } catch { /* never copy diagnostics */ } }
    const body = Buffer.concat(chunks);
    if (method === 'GET' && status !== 200)
      throw Object.assign(new Error('The feedback schema response must match the shipped contract.'), { code: 'FEEDBACK_RESPONSE_INVALID' });
    value = method === 'GET' ? validateFeedbackSchemaResponse(body) : validateFeedbackResponse(status, body);
    if ([429, 503].includes(status)) {
      const raw = res.headers.get('retry-after');
      // No arbitrary header text ever crosses into the agent's envelope.
      if (raw !== null && /^\d{1,6}$/.test(raw)) retry = Number(raw) * 1000;
    }
  } catch (error) {
    const code = error.code === 'FEEDBACK_RESPONSE_INVALID' ? error.code
      : signal.aborted ? 'FEEDBACK_REQUEST_TIMEOUT' : 'FEEDBACK_TRANSPORT_FAILED';
    failure = { code, message: code === 'FEEDBACK_RESPONSE_INVALID'
      ? 'The feedback response did not match the shipped contract; its body and headers were withheld.'
      : 'The feedback attempt did not complete. No automatic retry was made; keep the local receipt.' };
  }
  const evidence = { path: evidenceFile, id: runId };
  writeOutputFileAtomic(evidenceFile, JSON.stringify({ runId,
    origin: requestEvidenceOrigin(args[REQUEST_ORIGIN] ?? 'library.batch', 'http', httpEvidenceScope(url, method)),
    request: { method, url: url.href, headers: { accept: 'application/json', ...(prepared ? { 'content-type': 'application/json' } : {}) }, body: prepared?.payload ?? null, authUsed: false },
    response: { status, body: failure ? null : value, bytes: responseBytes, ...(failure ? { withheld: true } : {}) },
    durationMs: Date.now() - started, ...(failure ? { error: failure } : {}),
  }, null, 2), { mode: 0o600 });
  const result = errorEnvelope({ id: args.id ?? null, known, status, error: failure,
    code: status === 429 ? 'FEEDBACK_RATE_LIMITED' : status === 503 ? 'FEEDBACK_UNAVAILABLE' : 'FEEDBACK_REJECTED',
    message: 'Feedback was not accepted; no automatic retry was made.' });
  result.evidence = evidence;
  if (prepared) result.feedback_receipt = prepared.receipt;
  if (retry !== null) result.rate_limit = { retry_after_ms: retry, throttled_by_server: status === 429 };
  if (!failure) {
    result.assertions = runAssertions(args.expect, { status, headers: {}, body: value });
    result.ok = [200, 202].includes(status) && (result.assertions === null || result.assertions.failed === 0);
    result.mode = result.assertions ? 'assert' : 'passthrough';
    result.data = value;
    if (result.ok) result.error = null;
  }
  const fits = () => tokens(JSON.stringify(result)) <= clientRuntime().budget;
  if (!fits()) compactKnownMetadata(result.known);
  if (!fits() && method === 'GET' && result.data) {
    result.data = null;
    result.discovery = { truncated: 'The validated payload schema is in private evidence and the packaged contract.' };
  }
  if (!fits()) omitKnownNoteProjection(result.known);
  while (!fits() && result.known?.notes?.length) {
    result.known.notes.pop();
    const projection = result.known.note_projection;
    delete result.known.note_projection;
    Object.assign(result.known, trimmedNoteProjection(projection, result.known.notes.length));
    Object.assign(result.known, stackFactReceiptAfterTrim(result.known, result.known.notes.length));
    result.known.withheld ??= {};
    result.known.withheld.notes = (result.known.withheld.notes ?? 0) + 1;
  }
  if (!fits() && result.known) result.known = { op: result.known.op,
    ...stackFactReceiptAfterTrim(result.known), withheld: { ...result.known.withheld, known: 1 } };
  if (!fits()) {
    result.budget_min = 0;
    for (let i = 0; i < 4; i++) result.budget_min = tokens(JSON.stringify(result));
  }
  await logUsage({ ts: new Date().toISOString(), method, path: url.pathname, status, project: basename(clientRuntime().root),
    origin: url.origin, host: url.hostname, stack: clientRuntime().stack, rawBytes: responseBytes,
    envelopeBytes: Buffer.byteLength(JSON.stringify(result)), tokensSaved: Math.ceil(responseBytes / 4) - tokens(JSON.stringify(result)),
    authUsed: false, ok: result.ok, mode: result.mode, known: Boolean(known) }, []);
  return args._withBody ? { result, body: failure ? undefined : value } : result;
}

// Local reads are explicit author input, admitted only after routing, policy
// and authentication. Never follow a final symlink or wait for a FIFO/device;
// recheck the opened descriptor to cover replacement between lstat and open.
function readRequestFile(path, maxBytes = Infinity, limitCode = 'BODY_FILE_LIMIT') {
  const fail = code => { throw Object.assign(new Error(code === limitCode
    ? 'Body file expansion exceeds 16 MiB per file or 32 MiB combined encoded values.'
    : 'Request file must be a readable regular file, not a symbolic link or special file.'), { code }); };
  let fd;
  try {
    const abs = resolve(path), before = lstatSync(abs);
    if (!before.isFile() || before.isSymbolicLink()) fail('REQUEST_FILE_UNSAFE');
    if (before.size > maxBytes) fail(limitCode);
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) fail('REQUEST_FILE_UNSAFE');
    if (opened.size > maxBytes) fail(limitCode);
    const chunks = []; let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count; if (total > maxBytes) fail(limitCode);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (['REQUEST_FILE_UNSAFE', limitCode].includes(error.code)) throw error;
    fail(error.code === 'ELOOP' ? 'REQUEST_FILE_UNSAFE' : 'REQUEST_FILE_UNREADABLE');
  } finally { if (fd !== undefined) closeSync(fd); }
}

const BODY_FILE_MAX = 16 * 1024 * 1024, BODY_FILES_MAX = 32 * 1024 * 1024;
function expandBodyFiles(body) {
  let expandedBytes = 0;
  const invalid = () => { throw Object.assign(new Error('A body file value must be exactly {$file:{path,encoding,prefix?}}; encoding is utf8 or base64.'), { code: 'BODY_FILE_INVALID' }); };
  const expand = value => {
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, '$file')) {
      const file = value.$file;
      if (Array.isArray(value) || Object.keys(value).length !== 1 || !file || typeof file !== 'object' || Array.isArray(file)
          || Object.keys(file).some(key => !['path', 'encoding', 'prefix'].includes(key))
          || typeof file.path !== 'string' || !file.path || file.path.includes('\0')
          || !['utf8', 'base64'].includes(file.encoding) || file.prefix !== undefined && typeof file.prefix !== 'string') invalid();
      const prefix = file.prefix ?? '', available = BODY_FILES_MAX - expandedBytes - Buffer.byteLength(prefix);
      if (available < 0) throw Object.assign(new Error('Body file expansion exceeds the combined 32 MiB limit.'), { code: 'BODY_FILE_LIMIT' });
      // Base64 expands before it goes on the wire. Reserve its encoded size
      // before reading; even a file that grows during a read stays bounded.
      const maxBytes = Math.min(BODY_FILE_MAX, file.encoding === 'base64' ? Math.floor(available / 4) * 3 : available);
      const bytes = readRequestFile(file.path, maxBytes);
      let text;
      try { text = file.encoding === 'base64' ? bytes.toString('base64') : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw Object.assign(new Error('A utf8 body file must contain valid UTF-8 bytes.'), { code: 'BODY_FILE_ENCODING_INVALID' }); }
      const result = prefix + text; expandedBytes += Buffer.byteLength(result);
      return result;
    }
    return Array.isArray(value) ? value.map(expand) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
  };
  return expand(body);
}

const FILE_CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css',
  '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.ndjson': 'application/x-ndjson', '.pdf': 'application/pdf',
  '.xml': 'application/xml', '.zip': 'application/zip', '.gz': 'application/gzip', '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
function multipartFile(value) {
  const file = typeof value === 'string' ? { path: value } : value;
  if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['path', 'contentType', 'filename'].includes(key))
      || typeof file.path !== 'string' || !file.path || file.path.includes('\0')
      || file.contentType !== undefined && (typeof file.contentType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n\0]*)?$/.test(file.contentType))
      || file.filename !== undefined && (typeof file.filename !== 'string' || !file.filename || /[\r\n\0]/.test(file.filename)))
    throw Object.assign(new Error('Multipart file must be a path or {path,contentType?,filename?} with valid metadata.'), { code: 'MULTIPART_FILE_INVALID' });
  return { path: file.path, filename: file.filename ?? basename(file.path), contentType: file.contentType ?? FILE_CONTENT_TYPES[extname(file.path).toLowerCase()] ?? 'application/octet-stream' };
}

async function apiRequestOnceInner({ method = "GET", path, upstream, params, body, fields, idempotency_key, expect, id, headers, body_type, files, save_to, paginate, capture_context, reveal_secrets, _withBody, _onAttempt, [READ_PROBE]: probe, [MAP_READ]: mapRead, [REQUEST_ORIGIN]: initiator = 'library.batch', [REQUIRED_STEP_AUTH]: requiredAuth }, signal) {
  if (save_to) safeSaveDestination(save_to);
  safeOutputPath(join(clientRuntime().evidence, ".gitignore"));
  const target = probe?.target ?? resolveTarget(path, upstream);
  if (target.error) return errorEnvelope({ id: id ?? null, mode: "refused", error: target.error });
  const url = target.url;
  if (mapRead && String(authContextFor(url)?.auth ?? '').startsWith('oauth:'))
    return errorEnvelope({ id: id ?? null, mode: 'refused', code: 'MAP_OAUTH_REQUIRES_EXPLICIT_REQUEST',
      message: 'An OAuth grant needs an explicit request; the visualization probe sent nothing.' });
  // Query parameter NAMES written into the request path (`/x?a=1&b=2`), read
  // before structured params or query authentication touch the URL. Only the
  // names reach the stored request shape, beside the structured `params`
  // names; values never do. See pathQueryNames for the rules.
  const writtenQuery = pathQueryNames(url.search);
  // This is the only attempt counter used by batch/suite reporting. Keep it at
  // the fetch boundary: interpolation, policy, config, auth, and wait_for
  // validation can all refuse before any API request is sent. Conversely,
  // redirects, retries, and pagination are distinct real attempts and each
  // crosses this helper once, including when fetch throws.
  let httpAttempts = 0;
  const transport = async (requestUrl, requestInit) => {
    if (isBuiltinFeedbackTarget(String(requestUrl)))
      throw Object.assign(new Error('Automatic requests cannot enter the feedback service. Use the explicit feedback send flow.'), { code: 'FEEDBACK_REQUEST_INVALID' });
    signal.throwIfAborted();
    if (requiredAuth !== undefined) {
      const sentUrl = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
      const selected = authContextFor(sentUrl);
      const sentHeaders = new Headers(requestInit.headers);
      const failRequirement = code => { throw Object.assign(new Error('The imported authentication requirement is not satisfied for this request attempt; no additional request was sent.'), { code }); };
      if (requiredAuth === 'none') {
        if (selected?.auth || cookieHeaderFor(sentUrl) || sentUrl.username || sentUrl.password
            || [...sentUrl.searchParams.keys()].some(name => SECRET_PARAMS.test(name))
            || [...sentHeaders.keys()].some(name => SECRET_HEADERS.test(name) || CREDENTIAL_SHAPED_HEADER.test(name)))
          failRequirement('IMPORTED_AUTH_ABSENCE_REQUIRED');
      } else {
        if (!sameAuthReference(requiredAuth, selected?.auth)) failRequirement('IMPORTED_AUTH_BINDING_REQUIRED');
        const reference = parseAuthReference(requiredAuth);
        const supplied = reference.scheme === 'query' ? sentUrl.searchParams.get(reference.param)
          : sentHeaders.get(reference.scheme === 'header' ? reference.name : 'authorization');
        if (!supplied) failRequirement('IMPORTED_AUTH_VALUE_REQUIRED');
      }
    }
    if (probe) {
      // Wait for the announcement to be written before any network I/O. A
      // failed output stream refuses the request instead of hiding traffic.
      try { await probe.onRequest({ method: requestInit.method, url: requestUrl.toString() }); }
      catch { throw Object.assign(new Error("The pre-request announcement could not be written."), { code: "CLIENT_PROBE_FAILED" }); }
      signal.throwIfAborted();
      probe.attempted = true;
    }
    httpAttempts++;
    _onAttempt?.();
    try { return await fetch(requestUrl, { ...requestInit, signal }); }
    catch (error) {
      if (probe) probe.transportFailed = true;
      throw error;
    }
  };
  const withSlot = (host, fn) => withHostSlot(host, fn, signal);
  const known = probe ? null : knownFor(String(method).toUpperCase(), url);
  const literalCredential = literalCredentialError(headers, params, url);
  if (literalCredential)
    return errorEnvelope({ id: id ?? null, mode: "refused", known, error: literalCredential });
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));

  // --- pagination plan (F4): validated before the first byte moves ----------
  // Default OFF; "all" still means "to the hard cap", never unbounded. A bad
  // value must refuse loudly — silently returning one page would look exactly
  // like a complete answer.
  let paginatePlan = null;
  if (paginate !== undefined && paginate !== null && paginate !== false) {
    const cap = (() => { const n = Number(process.env.API_PAGINATE_CAP);
      return Number.isFinite(n) && n >= 1 ? Math.min(100, Math.floor(n)) : 20; })();
    const wanted = paginate === "all" || paginate === true ? cap : Number(paginate?.max_pages);
    if (!Number.isFinite(wanted) || wanted < 1)
      return errorEnvelope({ id: id ?? null, mode: "refused",
        known,
        error: { kind: "config", code: "INVALID_PAGINATE",
          message: `paginate must be "all" or {"max_pages": N}, got ${JSON.stringify(paginate)}.`,
          next: 'Pass paginate: "all" (up to the hard cap) or {"max_pages": N}.' } });
    if (method.toUpperCase() !== "GET")
      return errorEnvelope({ id: id ?? null, mode: "refused",
        known,
        error: { kind: "config", code: "INVALID_PAGINATE",
          message: `paginate follows collection GETs; replaying a ${method.toUpperCase()} across pages would repeat the operation.`,
          next: "Remove paginate, or make this a GET." } });
    paginatePlan = { maxPages: Math.min(cap, Math.floor(wanted)) };
  }

  const started = Date.now();
  const init = { method: method.toUpperCase(), redirect: "manual",
    headers: probe ? { "user-agent": PRODUCT } : {} };
  // Zen returns text but GitHub rejects Accept:text/plain with HTTP 415. Use
  // its documented media type only for that exact target; other APIs choose
  // their normal representation instead of inheriting a forced Accept value.
  if (probe && url.href === "https://api.github.com/zen")
    init.headers.accept = "application/vnd.github+json";

  // A misconfigured environment must never silently fall back to a default base
  // URL. Check this and the production boundary before encoding a body or reading
  // any multipart file from disk: a refused request should have no local I/O
  // beyond resolving its configuration.
  if (clientRuntime().config.problems.length)
    return errorEnvelope({ id: id ?? null, mode: "refused", known,
      error: { kind: "config", ...clientRuntime().config.problems[0] } });

  // Production is a property of the host actually targeted, not only of the
  // default environment. A named production upstream must receive the same
  // write refusal as a selected production environment.
  const targetContext = target.context ?? authContextFor(url);
  if (requiredAuth !== undefined && requiredAuth !== 'none' && !sameAuthReference(requiredAuth, targetContext?.auth))
    return errorEnvelope({ id: id ?? null, mode: 'refused', known,
      error: { kind: 'config', code: 'IMPORTED_AUTH_BINDING_REQUIRED',
        message: 'This suite step requires an explicit matching credential reference on its selected host.',
        next: 'Bind the step auth reference in this host configuration; importing a reference does not grant access to an environment variable.' } });
  if (requiredAuth === 'none' && (targetContext?.auth
      || Object.keys(targetContext?.headers ?? {}).some(name => SECRET_HEADERS.test(name) || CREDENTIAL_SHAPED_HEADER.test(name))
      || cookieHeaderFor(url)))
    return errorEnvelope({ id: id ?? null, mode: 'refused', known,
      error: { kind: 'config', code: 'IMPORTED_AUTH_ABSENCE_REQUIRED',
        message: 'This suite step requires an unauthenticated host, but selected-host authentication, credential headers or session cookies are present.',
        next: 'Use a separately configured unauthenticated host and clean session. This step never disables or removes credentials.' } });
  const guard = productionGuard(targetContext ? {
    name: targetContext.name ?? clientRuntime().config.name ?? "default",
    baseUrl: targetContext.baseUrl,
    production: Boolean(targetContext.production),
  } : clientRuntime().config, init.method);
  if (guard) return errorEnvelope({ id: id ?? null, mode: "refused", known, error: guard });

  // JSON is the default because it is what APIs mostly speak now, but form and
  // multipart are ordinary requirements, not exotica: OAuth token endpoints are
  // form-encoded and every upload is multipart.
  const kind = body_type ?? (files ? "multipart" : "json");

  // A server that honours Idempotency-Key can collapse a duplicate write
  // authoritatively, which local coalescing cannot do across processes.
  const idemKey = NON_IDEMPOTENT.has(init.method)
    ? (idempotency_key ?? randomUUID()) : idempotency_key;
  if (idemKey) init.headers["idempotency-key"] = idemKey;

  // Static headers declared for THIS host (tracing, tenant pinning, etc.),
  // then per-request headers, which are more specific and therefore win. The
  // environment's static headers are scoped to the base origin the same way its
  // credential is: a tenant-pinning header configured for one host is a small
  // leak when sprayed at every vendor in the hosts map.
  const staticHeaders = probe ? {} : authContextFor(url)?.headers ?? {};
  for (const [k, v] of Object.entries(staticHeaders)) init.headers[k.toLowerCase()] = String(v);
  for (const [k, v] of Object.entries(headers ?? {})) init.headers[k.toLowerCase()] = String(v);

  // Cookies the host set earlier in this session. Applied before auth so a
  // credential can never be clobbered by a stale cookie header.
  const jarHeader = probe ? null : cookieHeaderFor(url);
  if (jarHeader && !init.headers.cookie) init.headers.cookie = jarHeader;

  let auth = probe ? { secrets: [], authUsed: null } : await applyAuth(url, init, { signal });
  let credentialProblem = null;
  if (auth.error) {
    // Existing single-value schemes may permit an unauthenticated read when a
    // value is missing. Native Basic requires both values before any dispatch.
    if (requiredAuth !== undefined && auth.error.code === 'AUTH_ENV_MISSING')
      return errorEnvelope({ id: id ?? null, mode: 'refused', known,
        error: { kind: 'config', code: 'IMPORTED_AUTH_VALUE_REQUIRED', message: 'The configured credential reference required by this suite step has no runtime value.', next: 'Supply the credential through this host’s configured environment, then retry.' } });
    if (mapRead || auth.required || auth.error.code !== "AUTH_ENV_MISSING") return errorEnvelope({ id, mode: "refused", known, error: auth.error });
    credentialProblem = auth.error;
    auth = { secrets: [], authUsed: null };
  }
  let secrets = [...auth.secrets, ...(probe ? [] : cookieValuesFor(url))];

  // File bytes are read only after admission, including required auth. Keep
  // this out of interpolation: captures cannot select paths, synthesize file
  // descriptors, or reinterpret the contents of a file as placeholders.
  try {
    // Capture and imported-case matching must see the transmitted value too,
    // never the descriptor's local path or its misleading object shape.
    body = expandBodyFiles(body);
    const outgoingBody = body;
    if (kind === 'form' && outgoingBody !== undefined) {
      init.body = new URLSearchParams(Object.entries(outgoingBody).map(([key, value]) => [key, String(value)]));
      init.headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (kind === 'multipart') {
      const form = new FormData();
      for (const [key, value] of Object.entries(outgoingBody ?? {})) form.append(key, String(value));
      // Validate every descriptor before the first multipart read.
      if (files !== undefined && (!files || typeof files !== 'object' || Array.isArray(files)))
        throw Object.assign(new Error('Multipart files must be a field-to-file object.'), { code: 'MULTIPART_FILE_INVALID' });
      const parts = Object.entries(files ?? {}).map(([field, value]) => [field, multipartFile(value)]);
      for (const [field, file] of parts) form.append(field, new Blob([readRequestFile(file.path)], { type: file.contentType }), file.filename);
      init.body = form; // fetch owns the multipart boundary.
    } else if (outgoingBody !== undefined) {
      init.body = typeof outgoingBody === 'string' ? outgoingBody : JSON.stringify(outgoingBody);
      init.headers['content-type'] ??= 'application/json';
    }
  } catch (error) {
    if (!/^(?:BODY_FILE_|REQUEST_FILE_|MULTIPART_FILE_)/.test(error.code ?? '')) throw error;
    return errorEnvelope({ id: id ?? null, mode: 'refused', known,
      error: { kind: 'config', code: error.code, message: error.message } });
  }

  let res = await withSlot(url.host, () => transport(url, { ...init, signal }));
  let rate = probe ? { rateLimited: false, waitMs: 0, rl: null } : observeRateLimit(url.host, res);

  // A 429 means the request was REJECTED, not executed, so retrying is safe by
  // the same reasoning as the 401 path. Wait only if the host asked for a delay
  // we are willing to hold; otherwise hand the agent the number and let it decide.
  let rateLimitWaited = 0;
  // Remember that a throttle happened even when the retry succeeds, otherwise
  // recovery makes throttling invisible in the telemetry exactly when it matters.
  const wasThrottled = rate.rateLimited;
  if (!probe && !mapRead && rate.rateLimited && rate.waitMs <= RETRY_AFTER_CAP_MS) {
    await sleep(rate.waitMs, signal);
    rateLimitWaited = rate.waitMs;
    res = await withSlot(url.host, () => transport(url, init));
    rate = observeRateLimit(url.host, res);
  }

  // A cached token can expire between the check and the call. One forced refresh
  // and one retry: enough to survive the race, few enough to never loop.
  let refreshed = false;
  if (!probe && !mapRead && res.status === 401 && auth.canRetry) {
    const retryAuth = await applyAuth(url, init, { forceRefresh: true, signal });
    if (!retryAuth.error) {
      auth = retryAuth;
      secrets = [...secrets, ...retryAuth.secrets];
      res = await withSlot(url.host, () => transport(url, { ...init, signal }));
      refreshed = true;
    }
  }
  const drift = [];

  // A redirect on a documented path is contract drift, not a detour. Report it,
  // then follow the chain so the agent still gets its answer in one call.
  //
  // Following exactly one hop was the original behaviour and it was wrong: a
  // two-hop chain returned the intermediate 302 as if it were the answer, with
  // mode=summary over an empty body. Real redirect chains are ordinary — auth
  // flows and canonical-URL fixups both produce them.
  secrets.push(...responseCookieValues(res));
  if (!probe) rememberCookies(url, res);
  let current = url;
  let currentInit = init;
  let redirectRefusal = null;
  let hop = 0;
  const seen = new Set([url.href]);
  for (; !probe && !mapRead && hop < MAX_REDIRECTS && res.status >= 300 && res.status < 400; hop += 1) {
    const location = res.headers.get("location");
    let next = null;
    try {
      if (location) next = new URL(location, current);
      if (next && !["http:", "https:"].includes(next.protocol)) throw responseFailure("RESPONSE_REDIRECT_INVALID");
    } catch { throw responseFailure("RESPONSE_REDIRECT_INVALID"); }
    drift.push({
      kind: "redirect",
      requested: current.pathname,
      served: next ? next.pathname : null,
      status: res.status,
      note: "Server redirected a documented path. Contract and server disagree; neither is assumed authoritative.",
    });
    if (!next) break;
    if (isBuiltinFeedbackTarget(next.href)) {
      redirectRefusal = { kind: 'policy', code: 'FEEDBACK_REDIRECT_REFUSED', message: 'A redirect cannot initiate a feedback request. Use the explicit feedback send flow.' };
      break;
    }
    if (seen.has(next.href)) {
      redirectRefusal = { kind: "transport", code: "RESPONSE_REDIRECT_LOOP", message: "Response redirect chain repeated a target." };
      drift.push({ kind: "redirect-loop", requested: next.pathname,
        note: `Redirect returned to ${next.pathname}, which was already visited. Stopped without following.` });
      break;
    }
    seen.add(next.href);

    // A credential is scoped to the provider it was configured for. A server that
    // redirects elsewhere must not be handed it — otherwise any upstream can
    // harvest the token by answering 302 to a host it controls. Same for the
    // cookie jar, which is looked up per host anyway.
    //
    // A DENYLIST of known credential headers cannot do this safely: agents pass
    // custom auth headers constantly (X-Vault-Token, X-Api-Token, X-Company-Key)
    // and the list can never enumerate them. Verified leak: X-Vault-Token
    // travelled to a server-chosen host while the note claimed nothing was
    // forwarded. So a provider-crossing hop keeps only an ALLOWLIST of headers that
    // are safe to show any host, and drops everything the caller supplied.
    const crossOrigin = next.origin !== current.origin;
    const crossProvider = crossesProviderScope(current, next);
    const boundary = crossOrigin ? 'origin' : 'provider';
    const redirectDropsBody = res.status === 303 ||
      ((res.status === 301 || res.status === 302) && currentInit.method === "POST");
    // 307/308 (and non-POST 301/302) preserve the request body. Following one
    // across providers would let a configured upstream exfiltrate a multipart
    // local file or arbitrary request body merely by choosing Location. The
    // destination was never configured, so stop before sending a byte there.
    if (crossProvider && currentInit.body !== undefined && !redirectDropsBody) {
      drift.push({ kind: `cross-${boundary}-body-redirect-refused`,
        requested: current.host, served: next.host,
        note: `Redirect crossed ${boundary} scopes while preserving the request body; it was not followed.` });
      redirectRefusal = { kind: "policy", code: `CROSS_${boundary.toUpperCase()}_BODY_REDIRECT_REFUSED`,
        message: `A redirect would preserve the request body across ${boundary} scopes, so it was not followed.`,
        next: "Call the destination directly only after configuring and reviewing that provider." };
      break;
    }
    let followHeaders = { ...currentInit.headers };
    if (crossProvider) {
      const kept = {};
      for (const [h, v] of Object.entries(followHeaders))
        if (SAFE_CROSS_ORIGIN_HEADERS.has(h)) kept[h] = v;
      const dropped = Object.keys(followHeaders).filter((h) => !SAFE_CROSS_ORIGIN_HEADERS.has(h));
      followHeaders = kept;
      const sourceAuth = parseAuth(authContextFor(current)?.auth);
      if (sourceAuth?.scheme === 'query') next.searchParams.delete(sourceAuth.param);
      drift.push({ kind: `cross-${boundary}-redirect`, requested: current.host, served: next.host,
        note: dropped.length
          ? `Redirect crossed ${boundary} scopes; ${dropped.length} request header(s) were dropped and not forwarded to ${next.host}.`
          : `Redirect crossed ${boundary} scopes to ${next.host}.` });
    }
    const jar = cookieHeaderFor(next);
    if (jar) followHeaders.cookie = jar;   // the redirect may have just set it
    else delete followHeaders.cookie;

    // 303, and 302/301 on POST in practice, become GET without a body.
    const followInit = { ...currentInit, headers: followHeaders, redirect: "manual",
      signal };
    if (redirectDropsBody) {
      followInit.method = "GET";
      delete followInit.body;
      delete followHeaders["content-type"];
    }

    // A redirect is a new destination decision. Never replay a write across an
    // origin boundary, even when it happens to have no body, and re-evaluate a
    // configured destination's production marker before every hop. Without
    // this check, a dev endpoint could answer 307 to a production host and a
    // bodyless DELETE would bypass the initial production guard.
    const nextContext = authContextFor(next);
    const redirectGuard = productionGuard(nextContext ? {
      name: nextContext.name ?? clientRuntime().config.name ?? "default",
      baseUrl: nextContext.baseUrl,
      production: Boolean(nextContext.production),
    } : clientRuntime().config, followInit.method);
    if (redirectGuard) {
      drift.push({ kind: "production-redirect-refused",
        requested: current.host, served: next.host,
        note: `${followInit.method} was not followed into production environment '${redirectGuard.details.environment}'.` });
      redirectRefusal = redirectGuard;
      break;
    }
    if (crossProvider && !["GET", "HEAD"].includes(followInit.method)) {
      drift.push({ kind: `cross-${boundary}-write-redirect-refused`,
        requested: current.host, served: next.host,
        note: `Redirect crossed ${boundary} scopes while preserving ${followInit.method}; it was not followed.` });
      redirectRefusal = { kind: "policy", code: `CROSS_${boundary.toUpperCase()}_WRITE_REDIRECT_REFUSED`,
        message: `A redirect would replay ${followInit.method} across ${boundary} scopes, so it was not followed.`,
        next: "Call the configured destination explicitly so its environment and production policy are checked before the write." };
      break;
    }
    res = await withSlot(next.host, () => transport(next, followInit));
    secrets.push(...cookieValuesFor(next), ...responseCookieValues(res));
    rememberCookies(next, res);
    current = next;
    currentInit = followInit;
  }
  // Only claim truncation when the hop BUDGET was actually exhausted. Breaking
  // early for a missing Location left a 3xx status that made this fire falsely —
  // "stopped after 5 redirects" on a chain that followed zero.
  if (hop === MAX_REDIRECTS && res.status >= 300 && res.status < 400)
    drift.push({ kind: "redirect-chain-truncated", requested: current.pathname,
      note: `Stopped after ${MAX_REDIRECTS} redirects; the status below is the last hop, not a final answer.` });

  const declaredContract = probe ? null : httpContractFor(current);
  if (declaredContract && !httpContractDeclaresPath(declaredContract.contract, current.pathname, { baseUrl: declaredContract.baseUrl })) {
    drift.push({ kind: "undeclared-path", requested: current.pathname, note: "The final response path is not declared in its provider's contract." });
  }

  // A binary body must not be read as text: it would be mangled, then truncated,
  // and the agent would receive a description of corrupted bytes. Retrieve it
  // properly, hash it, and hand back a pointer instead of a payload.
  const contentType = res.headers.get("content-type") ?? "";
  const binary = isBinaryType(contentType);
  let text = "", parsed, isJson = false, binaryInfo = null, binaryEvidence = null;
  if (binary) {
    const buf = await readResponseBytes(res);
    binaryEvidence = sanitizeEvidenceBody(buf);
    // An explicit download remains byte-for-byte the caller's requested file;
    // only automatically persisted evidence is replaced. The receipt makes a
    // secret-bearing explicit download visible without fingerprinting it.
    const savedBytes = save_to ? buf : binaryEvidence.body;
    binaryInfo = {
      content_type: contentType.split(";")[0] || "application/octet-stream",
      bytes: savedBytes.length,
      sha256: `sha256:${createHash("sha256").update(savedBytes).digest("hex").slice(0, 32)}`,
      ...(binaryEvidence.body_secrets.replaced ? (save_to
        ? { evidence_body_secrets: binaryEvidence.body_secrets, saved_unredacted: true, sha256: null, sha256_withheld: true }
        : { body_secrets: binaryEvidence.body_secrets, original_bytes: buf.length }) : {}),
    };
    if (save_to) {
      const dest = safeSaveDestination(save_to);
      mkdirSync(resolve(dest, ".."), { recursive: true });
      writeOutputFile(dest, savedBytes, { mode: 0o600 });
      binaryInfo.saved_to = dest;
  } else {
    const dest = join(clientRuntime().evidence, `${randomUUID()}.bin`);
    mkdirSync(clientRuntime().evidence, { recursive: true });
      protectEvidence(clientRuntime().evidence);
      warnIfEvidenceTracked(clientRuntime().evidence);
      writeOutputFile(dest, savedBytes, { mode: 0o600 });
      binaryInfo.saved_to = dest;
    }
    parsed = undefined;
    text = "";
  } else {
    text = await readResponseText(res);
    isJson = true;
    try { parsed = JSON.parse(text); } catch { parsed = text; isJson = false; }
    if (isJson) boundResponseJson(parsed);
  }
  const runId = `run-${randomUUID()}`;
  if (probe) probe.response = { status: res.status, http_ok: res.ok,
    duration_ms: Date.now() - started, rate_limit_headers: probeRateHeaders(res.headers),
    observed_at: new Date().toISOString(),
    // Transient display input for the default onboarding fortune only. Doctor
    // sanitizes it for a single human line; neither its JSON report nor the
    // shared observation receives response text from this field.
    ...(probe.targetSource === "default" && init.method === "GET"
      && url.href === "https://api.github.com/zen" && res.status === 200
      && typeof parsed === "string" ? { body: text.slice(0, 4096) } : {}) };
  mkdirSync(clientRuntime().evidence, { recursive: true });
  protectEvidence(clientRuntime().evidence);
  warnIfEvidenceTracked(clientRuntime().evidence);
  // Evidence is local, but a credential in a query string or an echoed auth header
  // would still be at rest on disk. Scrub before writing, not after. The run
  // file appears whole (temp file then rename): a parallel request listing the
  // evidence directory never reads it half written.
  const httpEvidence = {
    runId,
    origin: requestEvidenceOrigin(initiator, 'http', httpEvidenceScope(current, currentInit.method)),
    request: {
      method: init.method, url: url.toString(),
      headers: Object.fromEntries(Object.entries(init.headers)
        .map(([k, v]) => [k, SECRET_HEADERS.test(k) || CREDENTIAL_SHAPED_HEADER.test(k) ? "[redacted]" : v])),
      body: body ?? null,
      authUsed: auth.authUsed,
    },
    response: { status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k, CREDENTIAL_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v])),
      ...(binaryEvidence ? { body: binaryEvidence.body_secrets.replaced ? binaryEvidence.body.toString('utf8') : undefined,
        body_secrets: binaryEvidence.body_secrets } : sanitizeEvidenceBody(parsed)) },
    drift, durationMs: Date.now() - started,
    ...(probe ? { purpose: "onboarding", target_source: probe.targetSource, repo_contract: null } : {}),
  };
  const persistHttpEvidence = () => writeOutputFileAtomic(`${clientRuntime().evidence}/${runId}.json`,
    scrub(JSON.stringify(httpEvidence, null, 2), secrets, 'httpEvidence', { runId }), { mode: 0o600 });
  persistHttpEvidence();

  // --- pagination auto-follow (F4) -----------------------------------------
  // Opt-in only. The first response names the style; subsequent pages are
  // fetched inside this call and their rows accumulated, so one envelope
  // replaces the loop the agent would otherwise hand-roll. Never unbounded:
  // the page cap, the token budget, and a seen-set (a next link that repeats
  // or never advances is a loop, not more data) each stop it, and the pages
  // block says which one did.
  let pages = null;
  if (paginatePlan && res.ok && !binaryInfo && isJson) {
    const first = collectionOf(parsed);
    pages = { fetched: 1, rows: first.rows?.length ?? 0, style: null, complete: null, stopped_early: null };
    if (!first.rows) pages.note = "no collection in the response; nothing to follow";
    else {
      const all = [...first.rows];
      // Seed with the FINAL page URL, not an empty set. A next link that
      // cycles back to page 1 would otherwise not be recognised on the first
      // check, so page 1's rows were accumulated a second time before the loop
      // guard caught it — an inflated count on a self-cycling paginator.
      const seen = new Set([current.href]);
      // Rows already past the budget make further pages pure spend — the
      // envelope could not carry them. Projection changes what would actually
      // be carried, so the measurement respects `fields`.
      const pick = (r) => fields?.length && r && typeof r === "object"
        ? Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])) : r;
      const overBudget = () => tokens(JSON.stringify(all.map(pick))) > clientRuntime().budget;
      let pageBody = parsed, pageRes = res, pageUrl = current, lastLen = first.rows.length, lastStyle = null;
      for (;;) {
        const nxt = nextPageOf(pageRes, pageBody, lastLen);
        if (!nxt) {
          if (pages.fetched === 1) pages.note = "no pagination signal detected; completeness is unknown";
          else if (lastStyle === "link" || lastLen === 0) pages.complete = true;
          else {
            pages.stopped_early = "pagination_signal_lost";
            pages.note = "A later page omitted the pagination metadata needed to establish completion.";
          }
          break;
        }
        pages.style ??= nxt.style;
        lastStyle = nxt.style ?? lastStyle;
        if (nxt.stopped_early) { pages.stopped_early = nxt.stopped_early; pages.note = nxt.note; break; }
        if (nxt.done) { pages.complete = true; break; }
        if (pages.fetched >= paginatePlan.maxPages) { pages.stopped_early = "page_cap"; break; }
        if (overBudget()) { pages.stopped_early = "budget"; break; }
        let nextUrl;
        if (nxt.url) {
          try { nextUrl = new URL(nxt.url, pageUrl); }
          catch { pages.stopped_early = "bad_next_link"; break; }
          // A next link naming another origin gets nothing followed: the
          // credential and jar are scoped to THIS host, and a body that can
          // name a host is a body that can exfiltrate to it.
          if (nextUrl.origin !== current.origin) {
            pages.stopped_early = "cross_origin";
            drift.push({ kind: "pagination-cross-origin", requested: pageUrl.pathname, served: nextUrl.host,
              note: `rel=next points at ${nextUrl.origin}; not followed — credentials are scoped to ${current.origin}, and the collection is incomplete.` });
            break;
          }
        } else {
          nextUrl = new URL(pageUrl);
          nextUrl.searchParams.set(nxt.param, nxt.value);
          for (const [pk, pv] of Object.entries(nxt.keep ?? {}))
            if (!nextUrl.searchParams.has(pk)) nextUrl.searchParams.set(pk, pv);
        }
        if (crossesProviderScope(current, nextUrl)) {
          pages.stopped_early = 'provider_scope';
          drift.push({ kind: 'pagination-cross-provider',
            note: 'The next page leaves the configured provider scope; it was not followed and the collection is incomplete.' });
          break;
        }
        if (seen.has(nextUrl.href)) {
          pages.stopped_early = "loop";
          drift.push({ kind: "pagination-loop", requested: nextUrl.pathname,
            note: "The next-page link repeats a page already fetched. Stopped without following." });
          break;
        }
        seen.add(nextUrl.href);
        let pres, ptext;
        try {
          const pageHeaders = { ...currentInit.headers };
          const pageCookie = cookieHeaderFor(nextUrl);
          if (pageCookie) pageHeaders.cookie = pageCookie; else delete pageHeaders.cookie;
          secrets.push(...cookieValuesFor(nextUrl));
          pres = await withSlot(nextUrl.host, () => transport(nextUrl,
            { ...currentInit, headers: pageHeaders, body: undefined, signal }));
          secrets.push(...responseCookieValues(pres));
          rememberCookies(nextUrl, pres);
          ptext = await readResponseText(pres);
        } catch (error) {
          const named = normalizeNetworkError(error, signal);
          if (["RESPONSE_OVERSIZED", "REQUEST_TIMEOUT"].includes(named.code)) throw named;
          pages.stopped_early = "fetch_failed"; break;
        }
        observeRateLimit(nextUrl.host, pres);
        pages.fetched += 1;
        let pbody; try { pbody = JSON.parse(ptext); } catch { pbody = undefined; }
        if (pbody !== undefined) boundResponseJson(pbody);
        // Every page is evidence under the same rules as the first: complete,
        // scrubbed, on disk next to the run it belongs to.
        writeOutputFileAtomic(`${clientRuntime().evidence}/${runId}-p${pages.fetched}.json`, scrub(JSON.stringify({
          runId: `${runId}-p${pages.fetched}`, page_of: runId,
          origin: requestEvidenceOrigin(initiator, 'http', httpEvidenceScope(nextUrl, 'GET')),
          request: { method: "GET", url: nextUrl.toString() },
          response: { status: pres.status, ...sanitizeEvidenceBody(pbody !== undefined ? pbody : ptext.slice(0, 2000)) },
        }, null, 2), secrets, 'httpEvidence', { runId: `${runId}-p${pages.fetched}`, page_of: runId }), { mode: 0o600 });
        if (!pres.ok || pbody === undefined) { pages.stopped_early = "error_page"; break; }
        const prows = Array.isArray(pbody) ? pbody
          : first.key && Array.isArray(pbody[first.key]) ? pbody[first.key]
          : collectionOf(pbody).rows;
        if (!prows) { pages.stopped_early = "error_page"; break; }
        all.push(...prows);
        pageBody = pbody; pageRes = pres; pageUrl = nextUrl; lastLen = prows.length;
      }
      pages.rows = all.length;
      if (pages.stopped_early) pages.complete = false;
      if (pages.fetched > 1) {
        // Everything downstream reads `parsed`: hand it the merged collection —
        // the LAST page's meta (its cursor is the exhausted one) over every
        // accumulated row — and let `text` follow so gear selection and the
        // budget see the true size.
        parsed = Array.isArray(parsed) ? all : { ...pageBody, [first.key]: all };
        text = JSON.stringify(parsed);
      }
    }
  }

  const { rows, meta, key } = collectionOf(parsed);
  // A 429 telling us to back off is the single most actionable rate-limit
  // signal, and it was dropped whenever the server sent Retry-After but no
  // RateLimit-* headers — because the block was gated on the headers, not on the
  // throttle event. Emit it on any throttle, carrying whatever the server said.
  const throttled = wasThrottled || rate.rateLimited;
  const retryAfter = retryAfterMs(res.headers.get("retry-after"));
  const rateBlock = (rate.rl || throttled || res.status === 429) ? { rate_limit: {
    ...(rate.rl ?? {}),
    concurrency: laneFor(url.host).width,
    ...(res.status === 429 ? { throttled_by_server: true } : {}),
    ...(retryAfter != null ? { retry_after_ms: retryAfter } : {}),
    ...(throttled ? { throttled: true, waited_ms: rateLimitWaited } : {}),
  } } : {};

  // Something is learned when an operation fails repeatedly and then works. The
  // check runs BEFORE this request is appended to the log, because the detector
  // stops at the first success on the operation and this request is one.
  const friction = probe ? null : (() => {
    if (process.env.API_FRICTION_OFF === "1") return null;
    try {
      const hit = detectFriction(
        { host: url.hostname, method: init.method, path: templatePath(url.pathname), status: res.status },
        { logs: usageLogPaths(), alreadyNoted: Boolean(knownFor(init.method, url)?.notes?.length) });
      return hit ? frictionPrompt(hit) : null;
    } catch { return null; }   // never let detection break a request
  })();

  // Capture before presentation is budgeted. Full observations stay on disk;
  // their receipt must pay the same response budget as every other field.
  const httpCapture = (assertions) => {
    // Old stores remain readable and requests still execute. Do not let a
    // missing contract or an unmatched route hide the migration boundary.
    if (!probe && capture_context !== false && process.env.API_CONTEXT_OFF !== '1') {
      const migration = stacksMigrationCapture(clientRuntime().root);
      if (migration) return migration;
    }
    const responseTarget = authContextFor(current);
    const scope = httpContextScope(current, responseTarget, { baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource });
    if (clientRuntime().stack && !responseTarget?.contract && capture_context !== false && process.env.API_CONTEXT_OFF !== '1')
      return { state: 'limited', code: 'CONTRACT_NOT_BOUND',
        message: 'This stack has no bound contract. Shared capture was skipped; the request remains in private execution evidence.' };
    if (capture_context !== undefined || scope.eligible && process.env.API_CONTEXT_OFF !== '1') {
      if (capture_context === false || process.env.API_CONTEXT_OFF === '1')
        return captureHttpContext(clientRuntime().root, { capture_context });
      const identity = httpContextIdentity(current, responseTarget, { method: currentInit.method,
        baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource, environment: clientRuntime().config.name ?? 'default', stack: clientRuntime().stack ?? undefined });
      if (!identity) return { state: 'limited', code: 'HTTP_CONTEXT_ROUTE_UNRESOLVED',
        ...httpContextRouteResolution(current, responseTarget, { method: currentInit.method,
          baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource }) };
      const operation = identity.operation;
      const redirected = current.href !== url.href || currentInit.method !== init.method;
      // One filter for every query name in the request shape, so a capture
      // never fails because of a query name: a name written into the path
      // passes the promotion field-name scan and the store's own scans; a
      // structured `params` name passes the store's own scans (what it always
      // went through). A refused name is dropped and counted, never recorded.
      const query = recordedQueryNames(writtenQuery, params);
      const captured = captureHttpContext(clientRuntime().root, { capture_context,
        identity,
        // A path-written name carries an empty placeholder: the shape records
        // its name and type (a query value is a string), never the value.
        ...(!redirected ? { request: JSON.parse(scrub(JSON.stringify({ params: query.params, body: body ?? null }), secrets, 'request')) } : {}),
        // Shape keys can be credential echoes too. Keep raw values for actual
        // assertion evaluation, but scrub dynamic keys before shared promotion.
        response: parsed === undefined ? undefined : JSON.parse(scrub(JSON.stringify(parsed), secrets)), status: res.status, assertions,
        note_contradictions: deriveNoteContradictions(clientRuntime().contextReader?.current()?.ctx,
          { operation, status: res.status, response: parsed }),
        declaration: { protocol: 'http', method: currentInit.method, operation,
          schemaValidated: false, requestValidated: false, responseValidated: false,
          validationScope: 'declared-method-and-path-only' },
        omissions: redirected ? ['Only the final redirect response is represented; intermediate responses and redirected request structure were not captured.']
          : query.withheld ? [`${query.withheld} query name${query.withheld === 1 ? '' : 's'} withheld by the secret and promotion scans; the names are not recorded.`] : [],
        complete: !redirectRefusal && (!pages || pages.complete === true), attempts: httpAttempts, pages,
        evidencePaths: [join(clientRuntime().evidence, `${runId}.json`), ...Array.from({ length: Math.max(0, (pages?.fetched ?? 1) - 1) },
          (_, i) => join(clientRuntime().evidence, `${runId}-p${i + 2}.json`))] },
        { scope, keyLinking: { evidenceDir: clientRuntime().evidence, runId, contract: responseTarget?.httpContract } });
      const mount = httpContractMountInfo(responseTarget?.httpContract, responseTarget?.baseUrl);
      return mount.pathPrefix ? { ...captured, mount } : captured;
    }
    return undefined;
  };

  // Shared exit for every gear: scrub, log one usage row, return.
  const generatedReceipt = { evidence: runId };
  let dataSecretReceipt;
  const presentedEnvelope = env => setDataSecrets(JSON.parse(scrub(JSON.stringify(env), secrets, 'envelope', generatedReceipt)), dataSecretReceipt);
  const finish = async (env) => {
    const clean = presentedEnvelope(env);
    measureSavedRequests(clean.known);
    if (!clean.budget_min && tokens(JSON.stringify(clean)) > clientRuntime().budget) omitSavedRequests(clean.known);
    measureKnownCode(clean.known?.code);
    if (!clean.budget_min && tokens(JSON.stringify(clean)) > clientRuntime().budget) omitKnownCode(clean.known);
    await logUsage({
      ts: new Date().toISOString(),
      project: basename(process.cwd()),
      origin: originOf(url.hostname),
      host: url.hostname,
      method: init.method,
      ...(clientRuntime().stack ? { stack: clientRuntime().stack } : {}),
      path: scrubPath(templatePath(url.pathname)),
      queryKeys: [...url.searchParams.keys()],   // keys only; values can be secrets
      status: res.status,
      ok: res.ok,
      mode: clean.mode ?? "summary",
      authUsed: auth.authUsed,
      tokenRefreshed: refreshed,
      idempotencyKeySent: Boolean(idemKey),
      environment: probe ? null : clientRuntime().config.name ?? null,
      ...(probe ? { purpose: "onboarding", target_source: probe.targetSource } : {}),
      rateLimitRemaining: rate.rl?.remaining ?? null,
      laneWidth: laneFor(url.host).width,
      throttled: Boolean(wasThrottled || rate.rateLimited),
      throttleWaitMs: rateLimitWaited,
      rawBytes: text.length,
      envelopeBytes: JSON.stringify(clean).length,
      tokensSaved: tokens(text) - tokens(JSON.stringify(clean)),
      contractLoaded: Boolean(declaredContract),
      pagesFetched: pages?.fetched ?? null,
      drift: drift.map((d) => d.kind),
      // The receipt (F6c) counts gotchas actually DELIVERED, so delivery is
      // recorded here, at the moment it happens. Reconstructing it later by
      // matching the log against the context file would claim credit for notes
      // added AFTER the request ran — fabricated value, the one thing the
      // receipt must never contain. Note COUNT only: the texts live in the
      // committed context file, and this log never carries content.
      knownOp: clean.known?.op ?? null,
      knownNotes: clean.known?.notes?.length ?? 0,
      knownProviderHash: clean.known?.from?.root ? providerHash(clean.known.from.root) : null,
      friction: friction?.kind ?? null,
      ms: Date.now() - started,
      runId,
    }, secrets);
    return clean;
  };

  // --- one stable result shape. Every key is always present, null
  // when not applicable, so an agent never inspects a response to learn how to
  // read the response. `mode` says which fields carry the payload.
  const clauseOutcomes = [];
  const assertions = runAssertions(expect, {
    status: res.status,
    // Assertions see every header, including ones too noisy to return; the agent
    // sees the curated set. Asserting on something invisible was the bug.
    headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])),
    body: parsed,
  }, { onClause: outcome => { clauseOutcomes[outcome.index] = outcome; } });
  const asserted = assertions !== null;
  const assertionsPassed = asserted && assertions.failed === 0;
  // Keep the assertion outcome even when shared context is disabled or the
  // route has no contract. Finalize before context/draft capture binds the
  // evidence digest; the earlier receipt still survives a pagination error.
  // Only counts are added, never expected/actual values or response messages.
  if (assertions) {
    httpEvidence.assertions = { passed: assertions.passed, failed: assertions.failed };
    persistHttpEvidence();
  }

  const result = {
    v: ENVELOPE_VERSION,
    id: id ?? null,
    status: res.status,
    // A declared assertion is the caller's explicit claim to check: when all
    // of those checks pass, a non-2xx status is still a successful step. With
    // no assertions, retain the HTTP-success guard so an unverified error can
    // never look green.
    ok: !redirectRefusal && !pages?.stopped_early && (asserted ? assertionsPassed : res.ok),
    mode: redirectRefusal ? "refused" : asserted ? "assert" : fields?.length && isJson ? "projection"
      : isJson && tokens(text) <= clientRuntime().budget * 0.75 ? "passthrough" : "summary",
    assertions,
    data: null,
    // Six discovery fields collapse into one key. "Always present" costs ~5
    // tokens per null key per result; grouping keeps the no-sniffing contract
    // while cutting the floor roughly in half on the common case.
    discovery: null,
    headers: usefulHeaders(res),
    contract_delta: drift.length ? drift : null,
    rate_limit: rateBlock.rate_limit ?? null,
    environment: probe ? null : clientRuntime().config.name ?? null,
    ...routingFields(),
    // Query before httpCapture appends this response. It cannot become its own
    // earlier knowledge. Legacy confidence and notes retain their old meaning.
    known: probe ? null : scopedKnownFor(currentInit.method, current, knownFor(currentInit.method, current)),
    // Present only on the response that concluded a run of failures, which is
    // the one moment the agent still holds the reason it finally worked. Absent
    // on every other request, so the common case pays nothing for it.
    learned: friction,
    evidence: runId,
    ...(redirectRefusal ? { error: redirectRefusal } : {}),
    ...(pages?.stopped_early ? { error: {
      code: "PAGINATION_INCOMPLETE",
      message: `Pagination stopped at ${pages.rows} rows after ${pages.fetched} page(s): ${pages.stopped_early}.`,
    } } : {}),
  };
  const contextCapture = httpCapture(assertions);
  if (contextCapture) result.context_capture = contextCapture;
  // Contract contradictions are private suggestions, never automatic authored
  // knowledge. Bind only the complete final response to its actual stack and
  // evidence; redirected and paginated request inputs may belong elsewhere.
  if (!probe && capture_context !== false && process.env.API_CONTEXT_OFF !== '1' && clientRuntime().stack
    && !isBuiltinStack(clientRuntime().stack) && !redirectRefusal && !pages && current.href === url.href && currentInit.method === init.method) try {
    const target = authContextFor(current);
    const identity = httpContextIdentity(current, target, { method: currentInit.method,
      baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource,
      environment: clientRuntime().config.name ?? 'default', stack: clientRuntime().stack });
    Object.assign(result, recordDraftNotes(clientRuntime().root, { identity, contractFile: target?.contract,
      status: res.status, response: parsed, request: { body, params: Object.fromEntries(current.searchParams), headers: currentInit.headers },
      evidenceDir: clientRuntime().evidence, runId, secrets }));
  } catch { result.draft_notes_error = { code: 'DRAFT_CAPTURE_FAILED', message: 'Private draft suggestions could not be retained; the request evidence remains available.' }; }
  // Only the actual capture's generated receipt IDs are trusted, at their
  // exact envelope paths. Provider payloads and matching-looking IDs elsewhere
  // remain scrubbed, including when presentation compacts this receipt.
  if (contextCapture?.state === 'captured') {
    for (const key of ['operation_id', 'observation_id'])
      if (typeof contextCapture[key] === 'string') generatedReceipt[`context_capture.${key}`] = contextCapture[key];
  }
  // Import claims have their own lifetime and exact-clause evidence. Preserve
  // the existing capture opt-outs, and do not promote across redirects/pages.
  if (!probe) try {
    const claimTarget = authContextFor(current);
    const caseUrl = new URL(current);
    // Authentication is checked by its configured reference, never by hashing
    // credentials. A cookie jar adds session state absent from an import case.
    const claimAuth = parseAuth(claimTarget?.auth);
    if (auth.authUsed && claimAuth?.scheme === 'query') caseUrl.searchParams.delete(claimAuth.param);
    const authoredHeaders = {};
    for (const [key, value] of [...Object.entries(claimTarget?.headers ?? {}), ...Object.entries(headers ?? {})])
      authoredHeaders[key.toLowerCase()] = String(value);
    const recorded = recordImportedTestExecution(clientRuntime().root, { url: current, target: claimTarget,
      method: currentInit.method, baseUrl: clientRuntime().base, baseUrlSource: clientRuntime().config.baseUrlSource,
      environment: clientRuntime().config.name ?? 'default', stack: clientRuntime().stack ?? undefined, expect, outcomes: clauseOutcomes,
      complete: !redirectRefusal && !pages?.stopped_early,
      redirected: current.href !== url.href || currentInit.method !== init.method,
      paginated: Boolean(pages), authUsed: Boolean(auth.authUsed), authReference: claimTarget?.auth, capture_context,
      casePath: caseUrl.href, body, headers: authoredHeaders,
      cookieUsed: Boolean(currentInit.headers.cookie),
      unsupportedCase: Boolean(files || kind !== 'json' || credentialProblem),
      runId, evidencePath: join(clientRuntime().evidence, `${runId}.json`) });
    if (recorded) result.test_claim_capture = recorded;
  } catch { result.test_claim_capture = { state: 'failed', code: 'TEST_CLAIMS_CAPTURE_FAILED' }; }
  if (binaryInfo) { result.mode = "binary"; result.binary = binaryInfo; }

  // Keep execution/capture inputs untouched. The agent sees the same secret
  // scan as private evidence, with signed upload URLs readable. Explicit reveal
  // applies only to returned secrets; configured authentication stays protected.
  const presentation = reveal_secrets === true ? { body: parsed, assertions }
    : sanitizeResponsePresentation(parsed, assertions);
  result.assertions = presentation.assertions;
  const shownBody = presentation.body;
  const { rows: shownRows, meta: shownMeta, key: shownKey } = collectionOf(shownBody);
  const discovery = { count: rows ? rows.length : null, collection: shownKey ?? null,
                      truncated: null, shape: null, facets: null, pagination: shownMeta ?? null,
                      // The F4 summary: how many pages this envelope actually
                      // covers, and which guard stopped the follow if one did.
                      pages };
  const publishDiscovery = () => {
    const any = Object.values(discovery).some((v) => v !== null);
    result.discovery = any
      ? Object.fromEntries(Object.entries(discovery).filter(([, v]) => v !== null))
      : null;
  };

  const project = (o) => o && typeof o === "object"
    ? Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]])) : o;

  if (binaryInfo) {
    result.data = null;
  } else if (result.mode === "assert" && assertionsPassed) {
    // The whole point: a passing check needs no payload. This is where the
    // token win lives, and it is why assertions belong on the request.
    result.data = null;
  } else if (result.mode === "assert") {
    // A failure is exactly when detail is cheap and necessary.
    discovery.shape = isJson ? shapeOf(shownBody) : "text";
    result.data = shownRows ? shownRows.slice(0, 2) : shownBody;
    if (rows && rows.length > 2) discovery.truncated = `${rows.length - 2} more items omitted`;
  } else if (result.mode === "projection") {
    result.data = shownRows ? shownRows.map(project) : project(shownBody);
    const probe = rows?.[0] ?? parsed;
    const missing = fields.filter((f) => probe && typeof probe === "object" && !(f in probe));
    if (missing.length) discovery.unknown_fields = missing;
  } else if (result.mode === "passthrough") {
    result.data = shownBody;
  } else {
    discovery.shape = isJson ? shapeOf(shownBody) : "text";
    result.data = shownRows ? shownRows.slice(0, 2) : shownBody;
    if (rows && rows.length > 2) discovery.truncated = `${rows.length - 2} more items omitted`;
    discovery.facets = facetsOf(shownRows) ?? null;
  }
  publishDiscovery();

  // Compare against the selected original response once, before budget trims.
  // The existing final scrub contributes configured-auth replacements too;
  // explicit reveal never exempts those values.
  const originalData = result.data === null ? null
    : result.mode === 'projection' ? rows ? rows.map(project) : project(parsed)
    : result.mode === 'passthrough' ? parsed : rows ? rows.slice(0, 2) : parsed;
  const maskKey = key => JSON.parse(scrub(JSON.stringify(presentation.maskKey?.(key) ?? key), secrets));
  dataSecretReceipt = dataSecretsTracker(originalData, presentedEnvelope(result).data, maskKey);

  // Budget, cheapest-value-first: extra sample rows, then facets, then the
  // sample itself. Never the assertion failures or the drift.
  const total = rows ? rows.length : 1;
  // Short Basic usernames can expand substantially when echoed. Measure the
  // representation we actually return when choosing presentation omissions.
  const presentedTokens = o => tokens(JSON.stringify(presentedEnvelope(o)));
  const fits = o => presentedTokens(o) <= clientRuntime().budget;
  if (!fits(result)) compactKnownMetadata(result.known);
  if (!fits(result) && result.draft_notes?.length) {
    result.draft_notes = result.draft_notes.map(({ id, reason, evidence, accept }) => ({ id, reason, evidence, accept }));
    while (!fits(result) && result.draft_notes.length > 1) {
      result.draft_notes.pop(); result.draft_notes_omitted = (result.draft_notes_omitted ?? 0) + 1;
    }
    if (!fits(result)) result.draft_notes = result.draft_notes.map(({ id, reason, evidence }) => ({ id, reason,
      evidence: evidence.slice(0, 2), ...(evidence.length > 2 ? { evidence_omitted: evidence.length - 2 } : {}), details_omitted: true }));
    for (const draft of result.draft_notes) while (!fits(result) && draft.evidence.length > 1) {
      draft.evidence.pop(); draft.evidence_omitted = (draft.evidence_omitted ?? 0) + 1;
    }
  }
  const trimScopedKnown = () => {
    if (!result.known?.scoped || fits(result)) return;
    const priorBytes = Buffer.byteLength(JSON.stringify(result.known.scoped));
    const excessBytes = Math.max(0, tokens(JSON.stringify(result)) - clientRuntime().budget) * 4;
    result.known.scoped = compactHttpContext(result.known.scoped, Math.max(256, priorBytes - excessBytes - 32));
    if (fits(result)) return;
    delete result.known.scoped;
    result.known.withheld = { ...result.known.withheld, scoped: 1 };
  };
  // Earlier history must not displace the current response's linked change
  // notice. Its saved records can be retrieved separately by exact identity.
  if (result.context_capture?.change_notice) trimScopedKnown();
  if (!fits(result) && result.context_capture?.identity) {
    // A replaced damaged key_sources list is a signal, like a change notice.
    const { state, operation_id, observation_id, change_notice, key_sources } = result.context_capture;
    result.context_capture = { state, operation_id, observation_id,
      ...(change_notice ? { change_notice } : {}), ...(key_sources ? { key_sources } : {}), details_omitted: true };
    if (!fits(result) && change_notice)
      result.context_capture.change_notice = compactResponseChangeNotice(change_notice);
  }
  if (!fits(result) && Array.isArray(result.data) && result.data.length > 1) {
    result.data = result.data.slice(0, 1);
    discovery.truncated = `${total - 1} more items omitted`;
    publishDiscovery();
  }
  if (!fits(result) && discovery.facets) { discovery.facets = "omitted (over budget)"; publishDiscovery(); }
  // A non-JSON body arrives as a string and matched none of the cases above, so
  // HTML error pages and text documents escaped the budget entirely.
  if (!fits(result) && typeof result.data === "string") {
    // Converge instead of calculating. Two attempts at arithmetic here were both
    // wrong, because the overhead depends on the truncation message, which
    // depends on the overhead. A loop that shrinks until it fits cannot be wrong.
    const whole = result.data;
    discovery.truncated = `body truncated from ${whole.length} characters; fetch evidence for the whole of it`;
    publishDiscovery();
    let room = (clientRuntime().budget - 8) * 4;
    for (let i = 0; i < 16 && room > 0; i += 1) {
      result.data = `${whole.slice(0, room)}…`;
      if (fits(result)) break;
      room = Math.floor(room * 0.6);
    }
    if (!fits(result)) result.data = null;
  }
  if (!fits(result) && result.data && typeof result.data === "object") {
    result.data = null;
    discovery.truncated = `${total} items omitted (over budget); see shape, or fetch evidence`;
    publishDiscovery();
  }
  // Last resort: the SHAPE alone can exceed the budget on a pathological payload.
  if (!fits(result) && discovery.shape) {
    discovery.shape = "omitted (over budget); fetch evidence for the full structure";
    publishDiscovery();
  }
  // The friction prompt is roughly 110 tokens of prose, and it appears on the
  // ONE response that concluded a failure run — which may also be the largest.
  // The budget is a promise the whole tool rests on, so the prompt shrinks under
  // pressure rather than breaking it: first to the bare pointer, which still
  // carries the operation and the command, then away entirely.
  if (!fits(result) && result.learned?.note) {
    result.learned = { op: result.learned.op, pattern: result.learned.pattern,
                       write_it: result.learned.write_it };
  }
  if (!fits(result) && result.learned) result.learned = null;
  if (!fits(result) && result.context_capture) {
    const { state, code, reason, command, change_notice, key_sources } = result.context_capture;
    result.context_capture = { state, ...(code ? { code } : {}), ...(reason ? { reason } : {}),
      ...(command ? { command } : {}),
      ...(change_notice ? { change_notice: compactResponseChangeNotice(change_notice, { minimal: true }) } : {}),
      ...(key_sources ? { key_sources } : {}),
      // A named limited reason is already the complete minimal diagnosis.
      // Spend the remaining budget on saved knowledge rather than a flag
      // saying its longer explanatory wording was omitted.
      ...(state === 'limited' && reason ? {} : { details_omitted: true }) };
  }

  // `known` is part of the same envelope and must pay the same budget. Keep
  // the operation identity and grading first; drop lower-value shape/enums,
  // then projection labels, then the tail of the notes. Name every withheld
  // field as we go. The algorithm is independent of whether `known` came from local
  // context or a granted provider, so both arms face the same rule.
  const trimKnown = () => {
    if (!result.known || fits(result)) return;
    // Repeated omission prose costs more than a useful lesson on small
    // envelopes. Retain counts and the evidence recovery path concisely.
    if (discovery.truncated === `${total} items omitted (over budget); see shape, or fetch evidence`)
      discovery.truncated = `${total} items omitted; see evidence`;
    if (discovery.shape === 'omitted (over budget); fetch evidence for the full structure')
      discovery.shape = 'omitted (see evidence)';
    publishDiscovery();
    trimScopedKnown();
    if (fits(result)) return;
    omitSavedRequests(result.known);
    if (fits(result)) return;
    omitKnownCode(result.known);
    if (fits(result)) return;
    if (result.known.from_tests) {
      const tests = result.known.from_tests;
      for (const key of ['prerequisites', 'losses', 'claims']) {
        while (!fits(result) && tests[key]?.length) {
          tests[key].pop();
          tests.omitted ??= {};
          tests.omitted[key] = (tests.omitted[key] ?? 0) + 1;
        }
      }
      if (!fits(result)) {
        delete result.known.from_tests;
        result.known.withheld = { ...result.known.withheld, from_tests: 1 };
      }
    }
    if (fits(result)) return;
    while (!fits(result) && result.known.account_facts?.records?.length) {
      Object.assign(result.known, accountFactReceiptAfterTrim(result.known, result.known.account_facts.records.length - 1));
    }
    if (fits(result)) return;
    const original = result.known;
    const notes = Array.isArray(original.notes) ? [...original.notes] : [];
    const kept = [...notes];
    const base = { ...original };
    delete base.notes;
    delete base.note_projection;
    delete base.withheld;
    const withheld = { ...original.withheld };
    if (base.note_history) {
      base.note_history = { state: base.note_history.state,
        issues: base.note_history.issues.slice(0, 2).map(({ code }) => ({ code })), details_omitted: true };
      withheld.note_history = 1;
    }
    if ("shape_hash" in base) { delete base.shape_hash; withheld.shape_hash = 1; }
    if ("enums" in base) {
      withheld.enums = Object.keys(base.enums ?? {}).length || 1;
      delete base.enums;
    }
    const apply = () => {
      const notesWithheld = notes.length - kept.length;
      result.known = {
        ...base,
        ...stackFactReceiptAfterTrim(original, kept.length),
        ...(kept.length ? { notes: kept } : {}),
        ...trimmedNoteProjection(original.note_projection, kept.length),
        ...(notesWithheld || Object.keys(withheld).length
          ? { withheld: { ...withheld, ...(notesWithheld ? { notes: notesWithheld } : {}) } }
          : {}),
      };
    };
    apply();
    // The canonical evidence class remains. Its redundant legacy timestamp
    // and confidence must not evict substantive notes and their review labels.
    for (const field of ["verified_at", "confidence"]) {
      if (!fits(result) && field in base) {
        delete base[field];
        withheld[field] = 1;
        apply();
      }
    }
    if (!fits(result)) {
      omitKnownNoteProjection(original);
      Object.assign(withheld, original.withheld);
      apply();
    }
    while (!fits(result) && kept.length) { kept.pop(); apply(); }
    if (!fits(result) && "from" in base) {
      delete base.from;
      withheld.from = 1;
      apply();
    }
    if (!fits(result)) {
      const history = base.note_history;
      const warning = history ? { note_history: { state: history.state,
        issues: history.issues.slice(0, 2).map(({ code }) => ({ code })), details_omitted: true } } : {};
      const stackReceipt = { ...stackFactReceiptAfterTrim(original), ...accountFactReceiptAfterTrim(original) };
      result.known = { op: base.op, ...warning, ...stackReceipt, withheld: { ...withheld, ...(notes.length ? { notes: notes.length } : {}), known: 1 } };
      if (!fits(result)) result.known = { ...warning, ...stackReceipt, withheld: { ...withheld, ...(notes.length ? { notes: notes.length } : {}), known: 1 } };
    }
  };
  if (credentialProblem && (res.status === 401 || res.status === 403)) {
    result.error = { ...credentialProblem,
      message: `${credentialProblem.message} The server rejected the unauthenticated request with ${res.status}.` };
    result.ok = false;
  }
  trimKnown();
  if (!fits(result) && (result.context_capture?.change_notice || result.known?.note_history || result.known?.stack_facts || result.known?.account_facts)) {
    if (result.context_capture?.change_notice)
      result.context_capture.change_notice = compactResponseChangeNotice(result.context_capture.change_notice, { signalOnly: true });
    // As for protocol envelopes, name the measured minimum when the mandatory
    // response plus a compact integrity/change signal cannot fit a tiny budget.
    if (!fits(result)) {
      result.budget_min = 0;
      for (let i = 0; i < 4; i++) {
        const minimum = presentedTokens(result);
        if (result.budget_min === minimum) break;
        result.budget_min = minimum;
      }
    }
  }
  const finished = await finish(result);
  return _withBody ? { result: finished, body: parsed } : finished;
}

// --- standard batch envelope ----------------------------------------------
// One object in, one object out. Requests run in order; `capture` binds values
// for later steps so the agent is not the glue between them; `wait_for` polls
// inside the client so a long-running operation costs one turn, not seven.

// {name} placeholders resolve from captured values. Unresolved ones are an
// error, not a literal — silently sending "/operations/{opId}" would produce a
// 404 that looks like the API's fault.
function interpolate(value, captured, preserveType = false, literalFiles = false) {
  if (preserveType && typeof value === "string") {
    const exact = /^\{([A-Za-z_$][\w.$\[\]-]*)\}$/.exec(value);
    if (exact && Object.hasOwn(captured, exact[1])) return { out: captured[exact[1]], missing: [] };
  }
  if (typeof value === "string") {
    const missing = [];
    const out = value.replace(/(?<!\{)\{([A-Za-z_$][\w.$\[\]-]*)\}(?!\})/gu, (m, name) => {
      if (Object.hasOwn(captured, name)) return String(captured[name]);
      missing.push(name);
      return m;
    });
    return { out, missing };
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => interpolate(v, captured, preserveType, literalFiles));
    return { out: parts.map((p) => p.out), missing: parts.flatMap((p) => p.missing) };
  }
  if (value && typeof value === "object") {
    if (literalFiles && Object.hasOwn(value, '$file')) return { out: value, missing: [] };
    const missing = [], out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = interpolate(v, captured, preserveType, literalFiles);
      out[k] = r.out; missing.push(...r.missing);
    }
    return { out, missing };
  }
  return { out: value, missing: [] };
}

// Interpolating into a PATH is not the same as interpolating into a body. A
// captured value is data from a server we do not trust, and a raw splice lets it
// change the request target: a captured id of `42/../../admin?elevate=1` turned
// `GET /things/{id}` into `GET /admin?elevate=1`, verified. So a value going into
// a path segment is percent-encoded, which keeps it inside its segment.
//
// And a leftover placeholder in a path is an error, not a literal. The old regex
// only recognised `{\w+}`, so `{op-id}` (a hyphen) was left in and sent as
// `%7Bop-id%7D` — the silent-literal 404 this check exists to prevent, walking
// straight through because of one unmatched character class.
function interpolatePath(path, captured) {
  const missing = [];
  const out = String(path).replace(/\{([^{}]*)\}/gu, (m, name) => {
    if (name && Object.hasOwn(captured, name)) return encodeURIComponent(String(captured[name]));
    missing.push(name || m);
    return m;
  });
  return { out, missing };
}

// Numeric knobs and inputs go through bare Number(), and Number("abc") is NaN,
// which then defeats every comparison it touches: a NaN concurrency limit makes
// `active >= width` always false (unbounded), a NaN timeout makes the deadline
// check always false (infinite poll). A bad input must fail to a safe value, not
// to a silently disabled guard.
const finite = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

const conditionMet = (spec, body) => {
  const actual = atPath(body, spec.json);
  if ("in" in spec) return Array.isArray(spec.in) && spec.in.includes(actual);
  if ("equals" in spec) return OPERATORS.equals(actual, spec.equals);
  if ("exists" in spec) return spec.exists === false ? actual === undefined : actual !== undefined;
  return false;
};

async function runOne(req, captured, { onAttempt, initiator } = {}) {
  if (Object.hasOwn(req, 'auth') && req.auth !== 'none' && !parseAuthReference(req.auth))
    return errorEnvelope({ id: req.id ?? null, mode: 'refused', code: 'IMPORTED_AUTH_BINDING_REQUIRED',
      message: 'This suite step needs a supported credential reference and a matching selected-host binding.' });
  if ((!req.protocol || req.protocol === 'http') && ['graphql', 'rpc', 'grpc', 'websocket'].some(key => req[key] !== undefined))
    return errorEnvelope({ id: req.id ?? null, mode: 'refused', code: 'PROTOCOL_REQUIRED',
      message: 'Set protocol explicitly when using a protocol-specific input object.' });
  // Environment variables are available to {name} placeholders too; captured
  // values from earlier steps win, since they are more specific.
  const scope = { ...clientRuntime().config.variables, ...captured };
  // Path is encoded and strictly checked; params and body are interpolated
  // plainly (params get URL-encoded downstream, body is JSON). Local file paths
  // are deliberately not interpolated from captured server data: capture must
  // never turn a response value into an arbitrary local read or write target.
  const pathR = interpolatePath(req.path, scope);
  const restR = interpolate({ params: req.params ?? null, headers: req.headers ?? null }, scope);
  const bodyR = interpolate(req.body ?? null, scope, false, true);
  const protocolR = interpolate({ variables: req.graphql?.variables ?? null, params: req.rpc?.params ?? null,
    body: req.grpc?.body ?? null, messages: req.grpc?.messages ?? null, send: req.websocket?.send ?? null }, scope);
  const expectR = interpolate(req.expect, scope, true);
  const resolved = { path: pathR.out, ...restR.out, body: bodyR.out };
  const missing = [...pathR.missing, ...restR.missing, ...bodyR.missing, ...protocolR.missing, ...expectR.missing];
  if (missing.length)
    return errorEnvelope({ id: req.id ?? null, known: knownForTarget(req.method, resolved.path, req.upstream), code: "UNRESOLVED_PLACEHOLDER",
      message: `No captured value for ${[...new Set(missing)].map((m) => `{${m}}`).join(", ")}.`,
      next: "Capture it in an earlier request, or remove the placeholder." });

  const base = { method: req.method, path: resolved.path, upstream: req.upstream,
                 stack: req.stack, environment: req.environment,
                 fields: req.fields, paginate: req.paginate, capture_context: req.capture_context, reveal_secrets: req.reveal_secrets,
                 idempotency_key: req.idempotency_key, id: req.id,
                 body_type: req.body_type,
                 ...(resolved.params ? { params: resolved.params } : {}),
                 ...(resolved.body !== null ? { body: resolved.body } : {}),
                 ...(resolved.headers ? { headers: resolved.headers } : {}),
                 ...(req.files ? { files: req.files } : {}),
                 ...(req.save_to ? { save_to: req.save_to } : {}),
                 _onAttempt: onAttempt, [REQUEST_ORIGIN]: initiator, ...(Object.hasOwn(req, "auth") ? { [REQUIRED_STEP_AUTH]: req.auth } : {}) };

  if (req.protocol && req.protocol !== "http") {
    if (Object.hasOwn(req, 'auth')) return errorEnvelope({ id: req.id ?? null, mode: 'refused', code: 'IMPORTED_AUTH_PROTOCOL_UNSUPPORTED',
      message: 'Per-step credential requirements are supported for HTTP suite steps only.' });
    Object.assign(base, { protocol: req.protocol, timeout_ms: req.timeout_ms,
      graphql: req.graphql ? { ...req.graphql, ...(req.graphql.variables !== undefined ? { variables: protocolR.out.variables } : {}) } : undefined,
      rpc: req.rpc ? { ...req.rpc, ...(req.rpc.params !== undefined ? { params: protocolR.out.params } : {}) } : undefined,
      grpc: req.grpc ? { ...req.grpc, ...(req.grpc.body !== undefined ? { body: protocolR.out.body } : {}),
        ...(req.grpc.messages !== undefined ? { messages: protocolR.out.messages } : {}) } : undefined,
      websocket: req.websocket ? { ...req.websocket, ...(req.websocket.send !== undefined ? { send: protocolR.out.send } : {}) } : undefined });
    // Polling must never turn a stream or an unknown-effect RPC into a replay.
    if (req.wait_for) return errorEnvelope({ id: req.id ?? null, mode: "refused", code: "PROTOCOL_OPTION_UNSUPPORTED",
      message: "wait_for is unavailable for protocol requests; use bounded stream completion controls." });
  }
  const execute = req.protocol && req.protocol !== "http" ? args => apiRequest(args, { initiator, [LEDGER_NESTED]: true }) : apiRequestOnce;

  const needsBody = Boolean(req.capture);
  if (!req.wait_for) {
    if (!needsBody) return execute({ ...base, expect: expectR.out });
    const response = await execute({ ...base, expect: expectR.out, _withBody: true });
    if (!response?.result) return response;
    const { result, body } = response;
    return { ...result, _captureSource: body };
  }

  // Polling repeats a request by definition. Restrict it to retrieval methods;
  // replaying a POST/PUT/PATCH/DELETE can create or destroy something on every
  // interval even when the first response already represented success.
  const pollMethod = String(req.method ?? "GET").toUpperCase();
  if (pollMethod !== "GET" && pollMethod !== "HEAD")
    return errorEnvelope({ id: req.id ?? null, mode: "refused", kind: "policy",
      known: knownForTarget(pollMethod, resolved.path, req.upstream),
      code: "INVALID_WAIT_FOR_METHOD",
      message: `wait_for cannot replay ${pollMethod}; only GET and HEAD are allowed.`,
      next: "Create or update the resource in one step, then poll its status with a separate GET or HEAD step." });

  // A present-but-non-numeric timeout is a caller mistake, and silently
  // substituting a default would hide it — worse, the old code let NaN through,
  // making `Date.now() + interval > deadline` always false: an unbounded poll
  // holding a host lane forever. Reject it loudly instead.
  for (const k of ["timeout_ms", "interval_ms"]) {
    const v = req.wait_for[k];
    if (v !== undefined && !Number.isFinite(Number(v)))
      return errorEnvelope({ id: req.id ?? null, known: knownForTarget(pollMethod, resolved.path, req.upstream), code: "INVALID_WAIT_FOR",
        message: `wait_for.${k} must be a number, got ${JSON.stringify(v)}.`,
        next: "Pass a millisecond count, or omit it to use the default." });
  }
  // Assertions run against each in-memory poll result. The result/body pair that
  // establishes success (or timeout) is returned directly, so wait_for never
  // makes an extra HTTP request merely to format its answer.
  const timeout = Math.min(finite(req.wait_for.timeout_ms, 30_000), 300_000);
  const interval = Math.max(100, finite(req.wait_for.interval_ms, 500));
  const deadline = Date.now() + timeout;
  let polls = 0;
  for (;;) {
    const response = await apiRequestOnce({ ...base, expect: expectR.out, _withBody: true });
    polls += 1;
    // Pre-flight refusals return a normal error envelope rather than a
    // result/body wrapper. They are terminal and must not be polled repeatedly.
    if (!response?.result) return response;
    const { result, body } = response;
    if (conditionMet(req.wait_for, body))
      return { ...result, polls, ...(needsBody ? { _captureSource: body } : {}) };
    if (Date.now() + interval > deadline) {
      return { ...result, ok: false, mode: "error", polls,
        error: { kind: "wait", code: "WAIT_FOR_TIMEOUT",
          message: `Condition on '${req.wait_for.json}' not met within ${timeout}ms after ${polls} polls.`,
          next: "Raise timeout_ms, or inspect the resource directly." } };
    }
    await sleep(interval);
  }
}

// Public capture summaries disclose only structure. The full values remain in
// this call for interpolation; this is independent of the evidence body policy.
function captureShape(value) {
  if (value === null) return { type: 'null' };
  const type = Array.isArray(value) ? 'array' : typeof value;
  return { type, ...(['string', 'array'].includes(type) ? { length: value.length }
    : type === 'object' ? { length: Object.keys(value).length } : {}) };
}
function captureStrings(value, into) {
  if (typeof value === 'string' && value) {
    into.add(value); into.add(encodeURIComponent(value));
    into.add(JSON.stringify(value).slice(1, -1));
  } else if (typeof value === 'number' && Number.isFinite(value)) into.add(String(value));
  else if (Array.isArray(value)) for (const child of value) captureStrings(child, into);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) captureStrings(child, into);
}
function hideCaptureValues(value, strings, sensitive = false, path = [], protocol = false) {
  // Numeric status/count metadata is not a response value. Within response and
  // assertion payloads, numeric captures are withheld too. Strings are scrubbed
  // everywhere, including concrete URLs, summaries and response-controlled keys.
  const hide = text => {
    for (const value of strings) {
      if (/^-?\d+(?:\.\d+)?$/.test(value)) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`(^|[\\s/=?&#:"'])${escaped}(?=$|[\\s/&#?"'])`, 'g'), '$1[capture withheld]');
      } else text = text.split(value).join('[capture withheld]');
    }
    return text;
  };
  if (path.join('.') === 'discovery.shape' && value !== null) {
    // This exact path is client-generated, never a payload inferred to be a
    // schema. Preserve its grammar/types; only property names came from the API.
    if (protocol) {
      const visit = node => ({ ...node,
        ...(node.properties ? { properties: Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [hide(key), visit(child)])) } : {}),
        ...(node.items ? { items: node.items.map(visit) } : {}) });
      return { ...value, shape: visit(value.shape) };
    }
    const visit = node => Array.isArray(node) ? node.map(visit)
      : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([key, child]) => [hide(key), visit(child)])) : node;
    return visit(value);
  }
  if (typeof value === 'string') {
    const field = path.join('.');
    const fixed = FIXED_SCRUB_VALUES.envelope[field]?.has(value)
      || field === 'protocol.name' && SCRUB_PROTOCOLS.has(value)
      || field === 'protocol.outcome' && SCRUB_OUTCOMES.has(value)
      || field === 'protocol.effect' && ['read', 'write', 'unknown'].includes(value)
      || field === 'error.code' || field === 'error.kind'
      || field === 'evidence' || ['context_capture.operation_id', 'context_capture.observation_id'].includes(field);
    return fixed ? value : hide(value);
  }
  if (typeof value === 'number' && sensitive && strings.includes(String(value))) return '[capture withheld]';
  if (Array.isArray(value)) return value.map((child, index) => hideCaptureValues(child, strings, sensitive, [...path, String(index)], protocol));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [sensitive ? hide(key) : key,
    hideCaptureValues(child, strings, sensitive || ['data', 'actual', 'expected', 'schema', 'sample'].includes(key), [...path, key], protocol)]));
  return value;
}
function targetCaptureNames(request) {
  const names = new Set();
  const visit = value => {
    if (typeof value === 'string') for (const match of value.matchAll(/\{([^{}]+)\}/gu)) names.add(match[1]);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(request.path);
  return names;
}
function batchScopeIdentity(req, captured) {
  const path = interpolatePath(req.path, { ...clientRuntime().config.variables, ...captured }).out;
  try {
    const target = resolveTarget(path, req.upstream);
    if (target.error) return null;
    return { path: target.url.pathname, scope: JSON.stringify([clientRuntime().stack ?? null, clientRuntime().config.name ?? null,
      target.url.origin, target.context?.baseUrl ?? clientRuntime().base]) };
  } catch { return null; }
}

export async function runEnvelope(envelope, internal) {
  const startedAt = new Date().toISOString();
  const result = await withCodeLocations(clientRuntime().root, () => runEnvelopeUnrecorded(envelope, internal));
  recordEnvelopeOutcome(batchOutcomeRecord(envelope, result, { initiator: evidenceInitiator(internal, 'library.batch'), startedAt }));
  return result;
}

async function runEnvelopeUnrecorded(envelope, internal) {
  const initiator = evidenceInitiator(internal, 'library.batch');
  const refused = (code, message) => ({ v: ENVELOPE_VERSION, ok: false, results: [], captured: {}, attempted: 0,
    left_behind: [], error: { code, message } });
  if (envelope.reveal_captures !== undefined && typeof envelope.reveal_captures !== 'boolean')
    return refused('REVEAL_CAPTURES_INVALID', 'reveal_captures must be a boolean. No requests executed.');
  if (envelope.finally !== undefined && (!Array.isArray(envelope.finally) || envelope.finally.some(req =>
    !req || typeof req !== 'object' || Array.isArray(req) || typeof req.path !== 'string' || !req.path)))
    return refused('FINALLY_INVALID', 'finally must be an array of request objects with paths. No requests executed.');
  const cleanup = envelope.finally ?? [];
  // Admit cleanup routing before the first write too; validation failures have
  // nothing to clean up and must not start the lifecycle in the first place.
  const requests = Array.isArray(envelope.requests) ? envelope.requests : [];
  const routingInputs = [envelope, ...requests, ...cleanup];
  for (const [index, input] of routingInputs.entries()) {
    if (input?.reveal_secrets !== undefined && typeof input.reveal_secrets !== 'boolean')
      return refused('REVEAL_SECRETS_INVALID', 'reveal_secrets must be a boolean. No requests executed.');
    const error = unsupportedRoutingError(input);
    if (error) return { ...refused(error.code, error.message), error: { ...error, details: { ...error.details,
      ...(index ? { request_index: index - 1 } : { scope: 'envelope' }) } } };
  }
  if (envelope.v !== undefined && envelope.v !== ENVELOPE_VERSION)
    return { ...refused('ENVELOPE_VERSION_UNSUPPORTED', `The supplied envelope version is unsupported; this client speaks envelope v${ENVELOPE_VERSION}.`),
      error: { code: 'ENVELOPE_VERSION_UNSUPPORTED', message: `The supplied envelope version is unsupported; this client speaks envelope v${ENVELOPE_VERSION}.`,
        next: `Review the equality assertions (see "Suite format and envelope versions" in docs/imports.md), then send "v": ${ENVELOPE_VERSION}.` } };
  if (!requests.length) return { ...refused('EMPTY_ENVELOPE', 'No requests supplied.'), error: { code: 'EMPTY_ENVELOPE', message: 'No requests supplied.',
    next: `Send {"v":${ENVELOPE_VERSION},"requests":[{"method":"GET","path":"/…"}]}.` } };
  const scoped = req => ({ ...req, reveal_secrets: req.reveal_secrets ?? envelope.reveal_secrets, stack: req.stack ?? envelope.stack,
    upstream: req.upstream ?? (req.stack === undefined ? envelope.upstream : undefined),
    environment: req.environment ?? envelope.environment });
  const scopedRequests = requests.map(scoped), scopedCleanup = cleanup.map(scoped);
  for (const [index, req] of [...scopedRequests, ...scopedCleanup].entries()) {
    try { requestStackScope(req); }
    catch (error) { return { ...refused(error.code, error.message),
      error: { ...stackRoutingError(error), details: { ...error.details, request_index: index } } }; }
  }
  const stopOnFailure = (envelope.on_failure ?? 'stop') === 'stop';
  const captured = Object.create(null), bindings = new Map(), created = [], hidden = new Set();
  const results = [], finallyResults = [];
  let attempted = 0;
  const run = async (req, index, phase) => {
    let result, target = null, scope = null;
    // Bind cleanup to the capture occurrence it actually consumed. Reusing a
    // variable name later cannot erase the previous creation's audit record.
    const consumed = [...targetCaptureNames(req)].map(name => bindings.get(name)).filter(Boolean);
    try {
      result = await withRequestRuntime(req, selected => {
        target = batchScopeIdentity(selected, captured); scope = target?.scope ?? null;
        return runOne(selected, captured, { initiator, onAttempt: () => { attempted += 1; } });
      });
    } catch (error) {
      // Preserve earlier steps and run cleanup even if a request throws. Never
      // include native exception text: it can contain response bytes or URLs.
      result = errorEnvelope({ id: req.id ?? null, error: transportError(error) });
    }
    const http = !req.protocol || req.protocol === 'http';
    const successfulResponse = Number.isInteger(result.status) && result.status >= 200 && result.status < 300
      && !(result.contract_delta ?? []).some(item => item.kind === 'redirect');
    const method = String(req.method ?? 'GET').toUpperCase();
    if (http && method === 'DELETE' && scope) for (const item of consumed) {
      if (item.scope !== scope || !item.resource_path || item.resource_path !== target?.path) continue;
      for (const alias of created.filter(other => other.creation === item.creation && other.value === item.value && other.scope === item.scope)) {
        if (Number.isInteger(result.status)) alias.delete_status = result.status;
        if (successfulResponse) alias.removed = true;
      }
    }
    // A 2xx create can fail its assertions after creating a resource. Retain its
    // captures for finally without turning the failed assertion into a pass.
    if ((http ? successfulResponse : result.ok) && req.capture && typeof req.capture === 'object') {
      for (const [name, path] of Object.entries(req.capture)) {
        const value = atPath(result._captureSource ?? result.data, path);
        if (value === undefined) continue;
        captured[name] = value; captureStrings(value, hidden); bindings.delete(name);
        if (http && ['POST', 'PUT'].includes(method) && scope &&
          ((typeof value === 'string' && value.length) || (typeof value === 'number' && Number.isFinite(value)))) {
          const encoded = encodeURIComponent(String(value));
          const resourcePath = method === 'POST' ? `${target.path.replace(/\/$/, '')}/${encoded}`
            : target.path.split('/').includes(encoded) ? target.path : null;
          const item = { resource_path: resourcePath, created_by: req.id ?? `${phase === 'finally' ? 'finally-' : ''}${index + 1}`, capture: name, scope, creation: `${phase}:${index}`, value, removed: false };
          created.push(item); bindings.set(name, item);
        }
      }
    }
    delete result._captureSource;
    return result;
  };
  for (const [index, req] of scopedRequests.entries()) {
    const result = await run(req, index, 'requests'); results.push(result);
    if (!result.ok && stopOnFailure) break;
  }
  // Cleanup is best effort, not stop-on-first-error: one failed delete must not
  // strand unrelated resources whose remaining cleanup can still succeed.
  for (const [index, req] of scopedCleanup.entries()) finallyResults.push(await run(req, index, 'finally'));
  const strings = [...hidden].sort((a, b) => b.length - a.length);
  const present = value => envelope.reveal_captures === true ? value : value.map(result => hideCaptureValues(result, strings, false, [], Boolean(result.protocol)));
  return {
    v: ENVELOPE_VERSION, ok: [...results, ...finallyResults].every(result => result.ok),
    results: present(results), ...(envelope.finally !== undefined ? { finally: present(finallyResults) } : {}),
    captured: envelope.reveal_captures === true ? captured : Object.fromEntries(Object.entries(captured).map(([name, value]) => [name, captureShape(value)])),
    attempted, stopped_early: results.length < requests.length,
    left_behind: created.filter(item => !item.removed).map(({ created_by, capture, delete_status }) => ({ created_by, capture,
      ...(delete_status !== undefined ? { delete_status } : {}) })),
  };
}

// fetch() collapses every network failure into "TypeError: fetch failed", with
// the real cause only on error.cause.code. A timeout deserves its own name and
// its own next action, because the fix is different.
export function transportError(error) {
  const named = normalizeNetworkError(error);
  return { kind: "transport", code: named.code, message: named.message,
    next: named.code === "REQUEST_TIMEOUT" ? "Review API_TIMEOUT_MS and the endpoint latency."
      : named.code.startsWith("RESPONSE_") ? "Review the response size, structure or redirect target."
      : "Check API_BASE_URL and the endpoint connection." };
}

// --- minimal MCP stdio server (JSON-RPC 2.0) ------------------------------
const STARTUP_STACKS = stackCatalog(DEFAULT_CONTEXT_ROOT).stacks.map(stack => stack.name);
const AUTH_STARTUP_STATE = authReadiness(DEFAULT_CONFIG.auth, credentialEnvironment(DEFAULT_CONFIG.credentialEnvFiles)).state;
const AUTH_DESCRIPTION = {
  none: '',
  invalid: ' Auth reference invalid; automatic authentication unavailable.',
  missing: ' Auth values missing at startup; authentication is unverified.',
  invalid_value: ' Auth values invalid at startup; automatic authentication unavailable.',
  present: ' Auth values present at startup; authentication is unverified.',
}[AUTH_STARTUP_STATE];

export const TOOL = {
  name: TOOL_NAME,
  description:
    (STARTUP_STACKS.length
      ? `Execute HTTP, GraphQL, JSON-RPC, gRPC or bounded WebSocket calls with fixed-shape results. Configured stacks at startup: ${STARTUP_STACKS.join(', ')}. Routing reads the current stack files on every request. `
      : `Execute HTTP, GraphQL, JSON-RPC, gRPC or bounded WebSocket calls against ${clientRuntime().base}; returns fixed-shape results. `) +
    `For non-HTTP set protocol and its input object; operation context is captured automatically. ` +
    `Pass 'expect' assertions: passing calls omit the body; failures return expected-vs-actual and bounded detail. ` +
    `'requests' batches steps; 'capture' feeds {name} into later steps, including expect. Captures stay private unless ` +
    `reveal_captures is true. 'finally' runs cleanup after failure; inspect left_behind. 'wait_for' polls inside the client. ` +
    `Reports drift, response shape, rate limits and evidence id; large bodies have named omissions. ` +
    `Use this for agent-issued calls to APIs the repository ` +
    `owns or consumes and integrations being explicitly added, including familiar endpoints, simple GET or POST calls, ` +
    `and health checks. ` +
    `Observations are not verified contracts. Exclude incidental web research, package downloads, source-control ` +
    `administration, and the coding host's own traffic unless that API is the integration under development. ` +
    `Keep existing request authorization and safety rules; this convention does not intercept the application's runtime traffic. ` +
    `Packaged ${FEEDBACK_STACK_NAME} is read-only HTTP knowledge. Feedback defaults to ask: use ${PRODUCT} feedback --send --confirm-send only after this session's human yes. Explicit allow requires disclosure; the never setting blocks sends. Sends scan payloads, keep private receipts and return fixed fields; no redirects, retries or shared capture. Schema reads are manual. ` +
    (STARTUP_STACKS.length ? ' Authentication is unverified; credentials resolve from the selected stack and environment.' : AUTH_DESCRIPTION),
  // This one tool can perform writes, save response bytes, and contact remote
  // services. MCP annotations are hints rather than enforcement, so advertise
  // the conservative truth for hosts that use them in approval UI.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: describeRequestInputs({
    type: "object",
    properties: {
      v: { type: "integer", enum: [ENVELOPE_VERSION], description: `Batch envelope version; omit to use the current version. Envelope v${ENVELOPE_VERSION} uses deep strict equality for equals and not_equals, including wait_for.` },
      protocol: { type: "string", enum: ["http", "graphql", "jsonrpc", "grpc", "websocket"], description: "Transport/operation semantics; defaults to http. Non-HTTP adapters execute once and report application outcomes and stream completion separately from status." },
      graphql: { type: "object", required: ["document"], properties: {
        document: { type: "string" }, operationName: { type: "string" }, variables: { type: "object" },
        schema: { type: "string", description: "Optional project-relative SDL or introspection JSON file for request validation." },
      }, description: "Standard GraphQL query, mutation, or graphql-transport-ws subscription. Apollo Federation-specific features are deferred." },
      rpc: { type: "object", required: ["method"], properties: { method: { type: "string" }, params: {}, id: {} }, description: "Single JSON-RPC 2.0 call; batches and notifications are unsupported." },
      grpc: { type: "object", required: ["proto", "service", "method"], properties: {
        proto: { type: "string" }, service: { type: "string" }, method: { type: "string" }, body: { type: "object" },
        messages: { type: "array", items: { type: "object" } }, max_messages: { type: "integer" },
        effect: { type: "string", enum: ["read", "write", "unknown"], description: "Caller-declared method effect, unverified; defaults to unknown. read permits observing a production stream without the write flag." },
      }, description: "Project-relative .proto, fully qualified service, and method. Unary or bounded server/client/bidirectional streaming; messages for client streams." },
      websocket: { type: "object", properties: {
        operation: { type: "string" }, send: { type: "array" }, max_messages: { type: "integer" },
        effect: { type: "string", enum: ["read", "write", "unknown"], description: "Caller-declared stream effect, unverified; defaults to unknown. read permits observing a production stream without the write flag. Applies equally to GraphQL subscriptions." },
        until: { type: "object" }, subprotocols: { type: "array", items: { type: "string" } }, timeout_ms: { type: "integer" },
        max_frame_bytes: { type: "integer" }, max_total_bytes: { type: "integer" },
      }, description: "Bounded JSON WebSocket session. operation identifies the channel. Completion is a matching until predicate or normal close; a message cap reports incomplete. Also configures GraphQL subscriptions." },
      timeout_ms: { type: "integer", minimum: 1, maximum: 300000, description: "Protocol deadline including authentication and transport; the inherited default (including API_TIMEOUT_MS) is clamped to 1–300000 ms. An explicit value outside this range is refused." },
      capture_context: { type: "boolean", description: `HTTP captures bounded context automatically when a unique route in the actual target's bound contract supplies a safe identity. Named upstreams bind their own hosts.<name>.contract and optional contractPathPrefix in ${LAYOUT.environments}. Missing or ambiguous bindings report HTTP_CONTEXT_ROUTE_UNRESOLVED; private evidence remains available. false opts out; true cannot bypass identity limits. Other protocols capture automatically and honor false. API_CONTEXT_OFF=1 disables shared context. Observations do not establish schema validity or passed assertions.` },
      curl: {
        type: "string",
        description: "A pasted curl command, parsed deterministically instead of translated by you. Splits host from path, converts flags, and REFUSES if it carries a literal credential — say so and tell the user to move it to an environment reference. Anything unrecognised is reported in curl_warnings, never dropped silently.",
      },
      method: { type: "string", description: "HTTP method (default GET)" },
      path: { type: "string", description: "Path, e.g. /pieces" },
      stack: { type: "string", description: "Explicit repository stack. Otherwise an absolute URL matches its configured origin and base path; a relative path uses default_stack or the only stack. Ambiguous targets refuse before sending." },
      environment: { type: "string", description: "Environment within the selected stack. Overrides API_ENV and the stack default; a missing environment refuses before sending." },
      upstream: {
        type: "string",
        description: "In stack repositories: a one-release alias for stack, reported in routing_alias. In legacy repositories: a named host from the config's \"hosts\" map. Routes this request to that host's baseUrl with that host's OWN credential — credentials never cross hosts. Omit to target the default base URL." +
          (clientRuntime().upstreams.size ? ` Configured: ${[...clientRuntime().upstreams.keys()].join(", ")}.` : ""),
      },
      params: { type: "object", description: "Query parameters" },
      body: { description: 'HTTP body. In batches, {name} captures interpolate; {{text}} is literal. A value may be {$file:{path,encoding:"utf8"|"base64",prefix?}}: literal cwd-relative path, regular file only, max 16 MiB/file and 32 MiB encoded total; no expansion in read-only or feedback. File contents are never interpolated.' },
      fields: {
        type: "array", items: { type: "string" },
        description: "Return only these keys from each record. Cheapest mode; use when you already know the shape.",
      },
      headers: {
        type: "object",
        description: "Headers for this request only, e.g. {\"Accept\":\"application/xml\",\"If-None-Match\":\"abc\"}. Merged over any environment headers; authentication is applied after and always wins.",
      },
      body_type: {
        type: "string", enum: ["json", "form", "multipart"],
        description: "How to encode the body. Defaults to json, or multipart when files are supplied.",
      },
      files: {
        type: "object",
        additionalProperties: multipartFileSchema,
        description: 'Multipart field -> local path or {path,contentType?,filename?}. MIME inferred from extension, otherwise application/octet-stream. filename may include a directory. Paths stay literal.',
      },
      save_to: {
        type: "string",
        description: "For a binary response, write it here instead of the evidence directory. The bytes are never inlined.",
      },
      idempotency_key: {
        type: "string",
        description: "Marks this write as safe to deduplicate. Reuse the same key to retry a write without risking a second one. Sent as Idempotency-Key, and identical in-flight calls sharing a key are collapsed locally.",
      },
      paginate: {
        description: "Follow pagination automatically on a collection GET: \"all\" or {\"max_pages\": N}. Detects next_cursor/next, page/per_page, offset/limit, including nested pagination/meta, or Link rel=\"next\". Rows accumulate within the token budget and hard page cap. Off by default. discovery.pages reports fetched pages, rows, stop reason, and complete: true at exhaustion, false on early stop, null when unknown. Incomplete pagination returns ok:false and PAGINATION_INCOMPLETE, preserving HTTP status, assertions, and evidence.",
      },
      expect: {
        type: "array",
        description: "Assertions. When ALL pass the response body is omitted entirely, which is the cheapest possible call. When one fails you get the body, the schema, and the expected-vs-actual. Clauses: {status:201}, {json:'a.b',equals:x}, and exists/in/matches/gt/lt/length/not_equals, plus {header:'name',equals:x}.",
        items: { type: "object" },
      },
      requests: {
        type: "array",
        minItems: 1,
        description: "Run several path-based requests in one call. Each entry takes the same request fields as above (including headers, body_type, files, save_to, and upstream, so one batch can span several authenticated hosts) plus capture ({name:'json.path'}) to bind a value for later steps via {name} placeholders, and wait_for ({json:'state',in:['succeeded','failed'],timeout_ms,interval_ms}) to poll a GET or HEAD inside the client instead of costing a turn per poll.",
        items: { type: "object", required: ["path"] },
      },
      finally: {
        type: "array", description: "Cleanup requests run after normal steps, including after failures. Every admitted cleanup step is tried; normal production-write and auth rules still apply.",
        items: { type: "object", required: ["path"] },
      },
      reveal_secrets: { type: "boolean", description: "Explicitly reveal detected response-body secrets in agent data and assertion detail for this request, or inherited by batch steps. Default false. Evidence and configured authentication secrets stay masked; reveal_captures is separate." },
      reveal_captures: { type: "boolean", description: "Explicitly reveal captured values in this batch's response. Default false: names and type/length only; captured values are withheld throughout step results." },
      on_failure: {
        type: "string", enum: ["stop", "continue"],
        description: "Batch behaviour when a request fails or an assertion fails. Default stop.",
      },
    },
    // MCP hosts validate this schema before dispatch. The old unconditional
    // `path` requirement made the documented curl-only and batch-only forms
    // impossible in strict hosts such as Codex. `anyOf` retains compatibility
    // with legacy callers that supplied the formerly-required path alongside a
    // batch while making each real entry mode independently valid.
    anyOf: [
      { required: ["path"] },
      { required: ["curl"] },
      { required: ["requests"] },
    ],
    allOf: ['finally', 'reveal_captures'].map(key => ({
      if: { required: [key] }, then: { required: ['requests'] },
    })),
  }),
};


// --- concurrency ----------------------------------------------------------
// Limit per TARGET HOST, not per client process. Rate limits, connection pools,
// and "do not stampede the dev server" are all properties of the host; a global
// limit needlessly serialises calls to unrelated APIs, and a per-process limit
// is unenforceable once agents can start more processes.
//
// API_CONCURRENCY=1 (default) reproduces the familiar one-at-a-time behaviour.
// Raising it is a number change, not a redesign.

const RETRY_AFTER_CAP_MS = Number(process.env.API_RETRY_AFTER_CAP_MS ?? 10_000);
// Without this a server that accepts a connection and never answers hangs the
// client forever — and holds its host's concurrency slot while it does, so one
// hung request deadlocks that lane permanently.


// Lane width is DISCOVERED, not configured. Hosts already publish their budget via
// RateLimit-* headers and 429/Retry-After; making an operator guess a number in an
// env var is the same failure as making an agent infer an enum it could have been
// told. Start at CONCURRENCY, widen on evidence of headroom, collapse on a 429.
const lanes = new Map();   // host -> {active, queue, width, limit, remaining, reset, pausedUntil}

const laneFor = (host) => {
  host = `${clientRuntime().partition}|${host}`;
  let lane = lanes.get(host);
  if (!lane) {
    lane = { active: 0, queue: [], width: clientRuntime().concurrency, limit: null, remaining: null,
             reset: null, pausedUntil: 0, observed: false };
    lanes.set(host, lane);
  }
  return lane;
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(responseFailure("REQUEST_TIMEOUT"));
  const abort = () => { clearTimeout(timer); reject(responseFailure("REQUEST_TIMEOUT")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true });
});
// Number(null) is 0 and Number("") is 0, so a bare Number() here invents a
// rate limit of 0/0 for every host that publishes no headers at all.
const numeric = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Retry-After is either delta-seconds or an HTTP date.
function retryAfterMs(value) {
  if (!value) return null;
  const secs = numeric(value);
  if (secs !== null) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

// Both the standard draft (RateLimit-*) and the de-facto X-RateLimit-*.
function readRateLimit(headers) {
  const g = (...names) => { for (const n of names) { const v = headers.get(n); if (v != null) return v; } return null; };
  const limit = numeric(g("ratelimit-limit", "x-ratelimit-limit"));
  const remaining = numeric(g("ratelimit-remaining", "x-ratelimit-remaining"));
  const reset = numeric(g("ratelimit-reset", "x-ratelimit-reset"));
  return (limit === null && remaining === null) ? null : { limit, remaining, reset };
}

function observeRateLimit(host, res) {
  const lane = laneFor(host);
  const rl = readRateLimit(res.headers);
  if (rl) {
    lane.observed = true;
    lane.limit = rl.limit ?? lane.limit;
    lane.remaining = rl.remaining ?? lane.remaining;
    lane.reset = rl.reset ?? lane.reset;
  }
  if (res.status === 429) {
    const wait = retryAfterMs(res.headers.get("retry-after")) ?? 1000;
    lane.pausedUntil = Date.now() + wait;
    lane.width = 1;                          // collapse hard; earn width back later
    return { rateLimited: true, waitMs: wait, rl };
  }
  // Widen only on evidence of headroom, one step at a time, never past the cap.
  if (lane.observed && lane.limit && lane.remaining !== null) {
    const headroom = lane.remaining / lane.limit;
    if (headroom > 0.5 && lane.width < clientRuntime().concurrencyMax) {
      lane.width += 1;
      while (lane.active < lane.width && lane.queue.length) lane.queue.shift()?.();
    } else if (headroom < 0.1 && lane.width > 1) {
      lane.width -= 1;
    }
  }
  return { rateLimited: false, rl };
}

// --- cookies ---------------------------------------------------------------
// A per-host jar, in memory only. Login flows are ordinary API work and were
// simply unreachable without this. Values never enter an envelope, the usage
// log, or evidence — the same rule credentials live under.
const COOKIES_ON = process.env.API_COOKIES !== "0";
// Provider isolation is deliberately stricter than a browser's Domain rule:
// even a Path=/ cookie cannot cross configured same-origin provider scopes.
const jars = new Map();
const cookieScope = url => {
  const target = authContextFor(url);
  return `${clientRuntime().partition}|${target && (target.basePath === '' || url.pathname === target.basePath
    || url.pathname.startsWith(`${target.basePath}/`)) ? `${target.origin}|${target.basePath}` : url.origin}`;
};
const cookieLines = res => typeof res.headers.getSetCookie === "function"
  ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
const responseCookieValues = res => cookieLines(res).map(line => {
  const pair = String(line).split(";", 1)[0], eq = pair.indexOf("=");
  return eq < 1 ? null : pair.slice(eq + 1).trim();
}).filter(Boolean);
function rememberCookies(url, res) {
  if (!COOKIES_ON) return;
  const scope = cookieScope(url), jar = jars.get(scope) ?? new Map();
  for (const line of cookieLines(res)) {
    const [pair, ...attributes] = String(line).split(";");
    const eq = pair.indexOf("="); if (eq < 1) continue;
    const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    const attrs = Object.fromEntries(attributes.map(attribute => {
      const at = attribute.indexOf("=");
      return at < 0 ? [attribute.trim().toLowerCase(), true]
        : [attribute.slice(0, at).trim().toLowerCase(), attribute.slice(at + 1).trim()];
    }));
    const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
    const path = typeof attrs.path === "string" && attrs.path.startsWith("/") ? attrs.path : defaultPath;
    const key = `${name}|${path}`;
    let expires = typeof attrs.expires === "string" ? Date.parse(attrs.expires) : Infinity;
    if (typeof attrs["max-age"] === "string" && /^-?\d+$/.test(attrs["max-age"])) expires = Date.now() + Number(attrs["max-age"]) * 1000;
    if (!value || expires <= Date.now()) { jar.delete(key); continue; }
    if (attrs.secure && url.protocol !== "https:") continue;
    if (attrs.domain && String(attrs.domain).replace(/^\./, "").toLowerCase() !== url.hostname.toLowerCase()) continue;
    jar.set(key, { name, value, path, secure: Boolean(attrs.secure), expires });
  }
  if (jar.size) jars.set(scope, jar); else jars.delete(scope);
}
function cookiesFor(url) {
  if (!COOKIES_ON) return [];
  const jar = jars.get(cookieScope(url)); if (!jar) return [];
  for (const [key, cookie] of jar) if (cookie.expires <= Date.now()) jar.delete(key);
  return [...jar.values()].filter(cookie => (!cookie.secure || url.protocol === "https:")
    && (cookie.path === url.pathname || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)))
    .sort((a, b) => b.path.length - a.path.length);
}
const cookieValuesFor = url => cookiesFor(url).map(cookie => cookie.value);
const cookieHeaderFor = url => cookiesFor(url).map(cookie => `${cookie.name}=${cookie.value}`).join("; ") || null;

// --- idempotency ----------------------------------------------------------
// The client itself never retries a request that might have executed: the only
// re-sends are after a 401 (the server rejected it) or a 3xx (the server
// redirected it), neither of which runs the operation. The real duplicate-write
// risk is one level up — two subagents issuing the same create, or an agent
// retrying after its own timeout. Two defences:
//
//   1. Send an Idempotency-Key on non-idempotent methods so a server that
//      supports them can collapse the duplicate authoritatively.
//   2. Coalesce identical in-flight requests locally, which works even against
//      a server with no idempotency support at all.
const NON_IDEMPOTENT = new Set(["POST", "PATCH"]);
const inFlight = new Map();   // fingerprint -> Promise

const fingerprint = (method, url, bodyText, key) =>
  createHash("sha256").update(`${clientRuntime().partition}|${method}|${url}|${bodyText ?? ""}|${key ?? ""}`).digest("hex");

// Coalescing a GET is always safe. Coalescing a WRITE is only safe when the
// caller has declared the duplicate unwanted, so it requires an explicit
// idempotency_key (or API_DEDUP_WRITES=1). Silently merging two creates that
// were genuinely meant to be two resources would be a data bug, not a saving.
const DEDUP_WRITES = process.env.API_DEDUP_WRITES === "1";
const mayCoalesce = (method, explicitKey) =>
  method === "GET" || method === "HEAD" ? true
    : (NON_IDEMPOTENT.has(method) || method === "PUT" || method === "DELETE")
      ? Boolean(explicitKey) || DEDUP_WRITES
      : false;

async function withHostSlot(host, fn, signal) {
  const lane = laneFor(host);
  // A 429 pauses the whole lane, not only the request that earned it.
  const pause = lane.pausedUntil - Date.now();
  if (pause > 0) await sleep(Math.min(pause, RETRY_AFTER_CAP_MS), signal);
  if (signal?.aborted) throw responseFailure("REQUEST_TIMEOUT");
  if (lane.active >= lane.width) await new Promise((resolve, reject) => {
    const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { const i = lane.queue.indexOf(ready); if (i >= 0) lane.queue.splice(i, 1); reject(responseFailure("REQUEST_TIMEOUT")); };
    lane.queue.push(ready);
    signal?.addEventListener("abort", abort, { once: true });
  });
  if (signal?.aborted) throw responseFailure("REQUEST_TIMEOUT");
  lane.active += 1;
  try { return await fn(); }
  finally {
    lane.active -= 1;
    lane.queue.shift()?.();
  }
}
