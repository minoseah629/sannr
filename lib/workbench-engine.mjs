// Allowlisted engine functions behind the local browser boundary. Nothing here
// has a shell or an HTTP transport; sends go through savedRequestAction/client.
import { basename, join, posix } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { buildViewModel } from './view.mjs';
import { stackCatalog, stackScope } from './stacks.mjs';
import { withStackScope } from './stack-scope.mjs';
import { loadOperationContextSources, queryLoadedOperationContext } from './operation-context.mjs';
import { authReadiness, credentialEnvironment } from './config.mjs';
import { parseAuthReference } from './auth-reference.mjs';
import { buildWorkbenchMap } from './workbench-map.mjs';
import { savedRequestAction, savedActionFailure } from './saved-request-actions.mjs';
import { inspectRecordedResponse } from './response-inspection.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { openEvidenceRoot, readEvidenceBytes } from './note-evidence.mjs';
import { sanitizeEvidenceBody } from './response-redaction.mjs';
import { WorkbenchRefusal } from './workbench-server.mjs';
import { LAYOUT } from './layout.mjs';
import { CLI_NAME, PROSE_PRODUCT_TITLE } from './brand.mjs';
import { appendWorkbenchEvent, readWorkbenchHandoff } from './workbench-handoff.mjs';
import { listWorkbenchAgents } from './workbench-agent.mjs';
import { buildSessionLedger } from './session-ledger.mjs';
import { latestAgentSession, summarizeLedgerSession } from './session-summary.mjs';
import { workbenchSessionModel } from './workbench-session.mjs';
import { reviewHandlers } from './workbench/review-model.mjs';
import { workbenchIndex, workbenchNote, workbenchOperation, workbenchMap, setAppearance, addResponse, addNote } from './workbench/workbench-model.mjs';

// Legacy headless setting, kept for existing readers. The Workbench page uses
// the appearance action (Light, Dark or System) and never applies these values.
const themes = new Set(['claims', 'slate', 'paper', 'ink']);
const LATEST_SESSION_CACHE_MS = 10_000;
const settingsDir = root => join(root, LAYOUT.evidence, 'workbench');
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new WorkbenchRefusal('WORKBENCH_PARAMETERS_INVALID', 'Use the documented action fields.');
};
function settings(root) {
  try {
    const opened = openEvidenceRoot(settingsDir(root));
    if (!opened) return { theme: 'claims' };
    const value = JSON.parse(readEvidenceBytes(opened, 'settings.json', { maxBytes: 256 }));
    return { theme: themes.has(value.theme) ? value.theme : 'claims' };
  } catch (error) {
    if (error.code === 'ENOENT') return { theme: 'claims' };
    throw new WorkbenchRefusal('WORKBENCH_SETTINGS_UNSAFE', 'Inspect the local evidence/workbench settings path.');
  }
}
function setSettings(root, params) {
  exact(params, ['theme']);
  if (!themes.has(params.theme)) throw new WorkbenchRefusal('WORKBENCH_THEME_INVALID', 'Use a supported legacy theme value; the Workbench appearance is set with the appearance action.');
  const dir = settingsDir(root);
  safeOutputPath(dir, { directory: true });
  safeOutputPath(join(dir, '.gitignore'));
  safeOutputPath(join(dir, 'settings.json'));
  let ignore = '';
  try {
    const opened = openEvidenceRoot(dir);
    if (opened) ignore = readEvidenceBytes(opened, '.gitignore', { maxBytes: 8192 }).toString('utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Independent ignore rule: no connect/setup or API binding mutation is needed.
  if (!ignore.endsWith('*\n!.gitignore\n')) writeOutputFileAtomic(join(dir, '.gitignore'), `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}*\n!.gitignore\n`, { mkdir: true, mode: 0o600 });
  writeOutputFileAtomic(join(dir, 'settings.json'), `${JSON.stringify({ theme: params.theme })}\n`, { mode: 0o600 });
  return { theme: params.theme };
}
const clean = value => sanitizeEvidenceBody(value).body;
export const WORKBENCH_SNAPSHOT_BYTES = 448 * 1024;
const DETAIL_ITEMS = 16, DETAIL_STRING_BYTES = 2048;
function detailProjection(value, path, omissions, depth = 0) {
  const omitted = (kind, count) => {
    omissions[kind] = (omissions[kind] ?? 0) + count;
    if (omissions.details.length < 32) omissions.details.push({ path, kind, omitted: count });
    else omissions.details_omitted++;
  };
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    if (bytes.length <= DETAIL_STRING_BYTES) return value;
    // Drop an incomplete final code point rather than expanding it to U+FFFD.
    let end = DETAIL_STRING_BYTES;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    omitted('string_bytes', bytes.length - end);
    return `${bytes.subarray(0, end).toString('utf8')}…`;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= 8) { omitted('nested_values', 1); return null; }
  if (Array.isArray(value)) {
    if (value.length > DETAIL_ITEMS) omitted('array_items', value.length - DETAIL_ITEMS);
    return value.slice(0, DETAIL_ITEMS).map((item, index) => detailProjection(item, `${path}.${index}`, omissions, depth + 1));
  }
  const entries = Object.entries(value);
  if (entries.length > 32) omitted('object_fields', entries.length - 32);
  return Object.fromEntries(entries.slice(0, 32).map(([key, item]) => [key, detailProjection(item, `${path}.${key}`, omissions, depth + 1)]));
}
function shortOp(item, path, omissions, historyComplete) {
  const notes = item.notes?.filter(n => !n.superseded).length ?? 0;
  const receipts = item.session_evidence ?? [], attention = item.attention_evidence ?? [];
  const latest = typeof item.latest_observed_at === 'string' && Number.isFinite(Date.parse(item.latest_observed_at))
    ? item.latest_observed_at : null;
  const codes = (item.latest_status_codes ?? []).filter(code => Number.isInteger(code) && code >= 100 && code <= 599);
  const recorded = Boolean(item.responses > 0 || latest || receipts.length || attention.some(row => row.basis?.run_id || row.basis?.expected_run_id));
  const failure = item.standing?.key === 'observed-after-failure' || item.standing?.tone === 'failure'
    || codes.some(code => code >= 400)
    || receipts.some(row => row.status >= 400 || row.assertions?.failed > 0 || row.left?.error || row.left?.refusal)
    || attention.some(row => ['http-failure', 'assertion-failure', 'transport-failure', 'request-error', 'refusal'].includes(row.kind));
  const available = historyComplete && !['unavailable', 'scope-unresolved'].includes(item.standing?.key)
    && !(item.session_evidence_omitted > 0);
  return { operation: item.op, anchor: item.operation_anchor,
    standing: detailProjection(item.standing, `${path}.standing`, omissions),
    evidence_class: detailProjection(item.evidence_class, `${path}.evidence_class`, omissions),
    responses: item.responses, notes, latest_status_codes: codes, latest_observed_at: latest,
    has_recorded_activity: recorded || notes > 0, has_recorded_failure: failure,
    // Absence describes available retained evidence, never proof of no API use.
    recorded_call_state: recorded ? 'recorded' : available ? 'not-recorded' : 'unknown' };
}
function views(model) { return model.stack_views ?? [{ name: null, model }]; }
const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function activityGroups(ledger) {
  // The ledger's sessions continue to mean host processes. These groups are
  // only a Workbench reading aid; every row keeps its original process/basis.
  const timeline = ledger.sessions.flatMap(session => session.rows.map((row, index) => ({
    session, row, index, at: instant(row.at),
  }))).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)
    || a.session.id.localeCompare(b.session.id) || a.index - b.index);
  const groups = [];
  for (const entry of timeline) {
    const { session, row, at } = entry;
    const initiator = row.kind === 'batch' ? session.hosts?.length === 1 ? session.hosts[0] : 'unknown'
      : row.attribution?.initiator ?? 'unknown';
    // Batches retain their envelope boundaries, including empty refusals.
    // Unknown attribution/timestamps never lend a neighboring row identity.
    const eligible = row.kind !== 'batch' && initiator !== 'unknown' && at !== null;
    const previous = groups.at(-1);
    let group = eligible && previous?.eligible && previous.initiator === initiator
      && at - previous.last <= ACTIVITY_WINDOW_MS ? previous : null;
    if (!group) {
      group = { id: `activity-${createHash('sha256').update(JSON.stringify([session.id, row.basis, row.at, entry.index])).digest('hex').slice(0, 24)}`,
        initiator, eligible, first: at, last: at, rows: [], sources: new Set(), stacks: new Set(), calls: 0,
        grouping: row.kind === 'batch' ? 'batch' : 'activity-window' };
      groups.push(group);
    }
    const children = row.kind === 'batch' ? row.rows ?? [] : [row];
    const source = child => ({ ...child, ledger_session_id: session.id });
    group.rows.push(row.kind === 'batch' ? { ...source(row), rows: children.map(source) } : source(row));
    group.sources.add(session.id); group.calls += children.length;
    for (const child of children) {
      if (child.stack) group.stacks.add(child.stack);
      const childAt = instant(child.at);
      if (childAt !== null) {
        group.first = group.first === null ? childAt : Math.min(group.first, childAt);
        group.last = group.last === null ? childAt : Math.max(group.last, childAt);
      }
    }
    if (row.stack) group.stacks.add(row.stack);
  }
  return groups.sort((a, b) => (b.last ?? -Infinity) - (a.last ?? -Infinity) || a.id.localeCompare(b.id)).map(group => ({
    id: group.id, grouping: group.grouping, initiator: group.initiator, hosts: [group.initiator],
    grouping_basis: group.grouping === 'batch' ? 'One recorded batch envelope; original request and cleanup identities are retained.'
      : 'Consecutive retained requests by the same known initiator, at most ten minutes apart. A display group is not a shared host process.',
    source_session_count: group.sources.size, started_at: group.first === null ? null : new Date(group.first).toISOString(),
    ended_at: group.last === null ? null : new Date(group.last).toISOString(), stacks: [...group.stacks].sort(),
    totals: { calls: group.calls }, rows: group.rows, rows_omitted: 0,
  }));
}
function boundedActivity(ledger, omissions) {
  let remaining = 100;
  const groups = activityGroups(ledger);
  const sessions = groups.slice(0, 20).map((session, sessionIndex) => {
    const rows = []; let omitted = session.rows_omitted ?? 0;
    const projectRow = (row, rowPath) => {
      const path = `activity.sessions.${sessionIndex}.rows.${rowPath}`;
      return { ...row, produced: { ...detailProjection(row.produced, `${path}.produced`, omissions),
        drift_total: row.produced?.drift?.length ?? 0, drift_omitted: Math.max(0, (row.produced?.drift?.length ?? 0) - DETAIL_ITEMS),
        drafts_total: row.produced?.drafts?.length ?? 0, drafts_omitted: Math.max(0, (row.produced?.drafts?.length ?? 0) - DETAIL_ITEMS),
        notes_written_total: row.produced?.notes_written?.length ?? 0,
        notes_written_omitted: Math.max(0, (row.produced?.notes_written?.length ?? 0) - DETAIL_ITEMS) } };
    };
    for (const [rowIndex, row] of [...(session.rows ?? []).entries()].reverse()) {
      const children = row.kind === 'batch' ? row.rows ?? [] : [row];
      const offset = Math.max(0, children.length - remaining);
      const selected = remaining ? children.slice(-remaining).map((child, index) => projectRow(child,
        row.kind === 'batch' ? `${rowIndex}.rows.${offset + index}` : rowIndex)) : []; remaining -= selected.length;
      omitted += children.length - selected.length;
      if (selected.length) rows.unshift(row.kind === 'batch' ? { ...row, rows: selected } : selected[0]);
      else if (!children.length && remaining) { rows.unshift(row); remaining--; }
    }
    return { ...session, stacks: detailProjection(session.stacks, `activity.sessions.${sessionIndex}.stacks`, omissions),
      rows, rows_shown: rows.reduce((sum, row) => sum + (row.kind === 'batch' ? row.rows.length : 1), 0), rows_omitted: omitted };
  });
  return { ...ledger, kind: 'workbench-activity', sources: detailProjection(ledger.sources, 'activity.sources', omissions),
    // The newest MCP host process, with the same fixed line the agent quotes.
    latest_session: latestAgentSession(ledger),
    sessions, sessions_omitted: Math.max(0, groups.length - sessions.length), presentation_groups_total: groups.length,
    ledger_rows_omitted: ledger.sessions.reduce((sum, session) => sum + (session.rows_omitted ?? 0), 0),
    workbench_row_bound: 100, display_basis: 'Totals cover the canonical ledger, including its host-process session count. At most 20 display groups and 100 retained calls are shown. Earlier ledger rows omitted before grouping are counted separately; nested details are limited to 16 items, with omissions named in snapshot_omissions.' };
}
function fitSnapshot(snapshot) {
  snapshot.snapshot_limits = { max_bytes: WORKBENCH_SNAPSHOT_BYTES, byte_fallback: false,
    note: 'Counts cover the retained ledger. Collections and nested details may be omitted for display; headless readers retain their own bounds.' };
  const bytes = () => Buffer.byteLength(JSON.stringify({ ok: true, result: snapshot }));
  // Shrink every collection together, keeping at least one navigation target
  // per stack/session/kind and preserving the original counts. Count bounds
  // alone cannot protect the HTTP byte limit when operation names are long.
  const halve = (owner, field, omitted) => {
    const items = owner[field] ?? [];
    if (items.length < 2) return;
    const keep = Math.ceil(items.length / 2);
    owner[field] = items.slice(0, keep); owner[omitted] = (owner[omitted] ?? 0) + items.length - keep;
  };
  for (let pass = 0; bytes() > WORKBENCH_SNAPSHOT_BYTES && pass < 10; pass++) {
    snapshot.snapshot_limits.byte_fallback = true;
    for (const stack of snapshot.stacks) {
      halve(stack, 'operations', 'operations_omitted'); halve(stack, 'environments', 'environments_omitted');
    }
    halve(snapshot.saved, 'requests', 'omitted');
    for (const session of snapshot.activity.sessions) {
      const calls = session.rows.reduce((sum, row) => sum + (row.kind === 'batch' ? row.rows.length : 1), 0);
      for (const row of session.rows) if (row.kind === 'batch' && row.rows.length > 1) row.rows = row.rows.slice(-Math.ceil(row.rows.length / 2));
      if (session.rows.length > 1) session.rows = session.rows.slice(-Math.ceil(session.rows.length / 2));
      session.rows_shown = session.rows.reduce((sum, row) => sum + (row.kind === 'batch' ? row.rows.length : 1), 0);
      session.rows_omitted += calls - session.rows_shown;
    }
    const attention = snapshot.activity.needs_attention;
    for (const group of attention.groups) { halve(group, 'items', 'omitted'); group.shown = group.items.length; }
    attention.shown = attention.groups.reduce((sum, group) => sum + group.items.length, 0);
    attention.omitted = attention.total === undefined ? null : attention.total - attention.shown;
  }
  if (snapshot.snapshot_limits.byte_fallback) snapshot.activity.display_basis = `${snapshot.activity.display_basis ?? 'The local ledger is unavailable.'} Additional items were omitted to fit the workbench byte budget; operation, session and attention totals are unchanged.`;
  if (bytes() > WORKBENCH_SNAPSHOT_BYTES) {
    // Last-resort bounded summary: never replace the whole page with an HTTP
    // size error. Preserve known totals and the ability to choose a stack.
    for (const stack of snapshot.stacks) {
      stack.operations_omitted += stack.operations.length; stack.operations = [];
      stack.environments_omitted += stack.environments.length; stack.environments = [];
    }
    snapshot.saved.omitted += snapshot.saved.requests.length; snapshot.saved.requests = [];
    snapshot.activity.sessions_omitted += snapshot.activity.sessions.length; snapshot.activity.sessions = [];
    snapshot.activity.sources = { omitted: true, reason: 'workbench byte budget' };
    const attention = snapshot.activity.needs_attention;
    for (const group of attention.groups) { group.omitted += group.items.length; group.items = []; group.shown = 0; }
    attention.shown = 0; attention.omitted = attention.total ?? null;
    snapshot.snapshot_limits.note = 'Detailed collections exceeded the display byte budget. Totals remain available; use headless readers for details.';
  }
  return snapshot;
}

export async function workbenchSnapshot(root) {
  const catalog = stackCatalog(root);
  let model, viewProblem;
  try { model = buildViewModel(root); }
  catch (error) { viewProblem = error.code ?? 'VIEW_UNAVAILABLE'; }
  const stackViews = model ? views(model) : [];
  const ledger = model?.sessions;
  const historyComplete = Boolean(ledger) && !(ledger.sources?.unreadable_files > 0 || ledger.sources?.files_beyond_read_bound > 0
    || ledger.sources?.unsafe_directories > 0 || ledger.needs_attention?.omitted > 0
    || ledger.sessions.some(session => session.rows_omitted > 0));
  const saved = await savedRequestAction(root, { action: 'list', limit: 100 });
  const omissions = { array_items: 0, string_bytes: 0, nested_values: 0, object_fields: 0, details: [], details_omitted: 0 };
  let remainingOperations = 500;
  const stacks = catalog.stacks.slice(0, 32).map(row => {
    const scoped = stackViews.find(v => v.name === row.name)?.model;
    const operations = scoped?.operations ?? [];
    // Keep navigation identities exact. Overlong identities are omitted, never
    // truncated into a different operation that could be opened or sent.
    const selected = operations.filter(item => typeof item.op === 'string' && Buffer.byteLength(item.op) <= 2048).slice(0, remainingOperations);
    remainingOperations -= selected.length;
    const environmentNames = Object.keys(row.document.environments);
    return { name: row.name, default_environment: row.document.default_environment ?? null,
      contract_state: scoped?.contract_state ?? 'missing',
      environments: environmentNames.slice(0, 20).map(name => {
        try {
          const { config } = stackScope(root, { stack: row.name, environment: name });
          const readiness = authReadiness(config.auth, credentialEnvironment(config.credentialEnvFiles));
          return { name, credential_readiness: readiness, production: config.production === true,
            credential_reference: parseAuthReference(config.auth) ? config.auth : null,
            credential_file: config.credentialEnvFiles?.length ? 'configured local env file; values not exposed' : null };
        } catch (error) { return { name, credential_readiness: { state: 'unavailable', vars: [] }, problem: error.code ?? 'STACK_UNAVAILABLE' }; }
      }), environments_omitted: Math.max(0, environmentNames.length - 20),
      operations: selected.map((item, index) => shortOp(item, `stacks.${row.name}.operations.${index}`, omissions, historyComplete)), operations_total: operations.length, operations_omitted: operations.length - selected.length };
  });
  return fitSnapshot(clean({ product: PROSE_PRODUCT_TITLE, project: basename(root), generated_at: new Date().toISOString(), settings: settings(root),
    setup: { state: catalog.stacks.length ? 'configured' : 'not configured',
      next: catalog.stacks.length ? null : `Run ${CLI_NAME} connect in this repository, then add a stack and its local environment. Opening this page changes nothing.`,
      problems: catalog.problems.slice(0, 32).map(p => ({ code: p.code, stack: p.stack ?? null })), problems_omitted: Math.max(0, catalog.problems.length - 32), view_problem: viewProblem ?? null,
      survey: { state: 'not available', note: 'No API survey is supplied to this workbench. Stored operations are shown below.' } },
    stacks, stacks_omitted: Math.max(0, catalog.stacks.length - stacks.length), saved,
    activity: ledger ? boundedActivity(ledger, omissions)
      : { state: 'unavailable', sessions: [], totals: null, latest_session: null, needs_attention: { state: 'unavailable', groups: [] } },
    snapshot_omissions: omissions,
  }));
}

// The API detail follows the operation's retained context, not Activity's
// recent-row window. Old scopes and missing receipts remain visible, but are
// never promoted into the map's current-scope response count. The shared
// context reader validates metadata and hashes evidence; bodies are returned
// only after an explicit Send or Inspect action, never for API-index previews.
function recordedResponses(root, stack, operation, currentScope) {
  const scope = stackScope(root, { stack });
  return withStackScope(scope, () => {
    const loaded = loadOperationContextSources(root);
    // This local drill-down cannot lend a different repository's evidence ID
    // to the local inspector, even when that repository has a context grant.
    const saved = queryLoadedOperationContext({ ...loaded, sources: loaded.sources.filter(source => source.id === 'local'), skipped: [] },
      { operation: operation.op, stack, protocol: 'http' }, { maxItems: 100, maxBytes: 1024 * 1024 });
    const items = [];
    let historyOmitted = 0;
    for (const entry of saved.operations) {
      historyOmitted += entry.omitted_observations;
      const identity = entry.identity;
      for (const observation of entry.observations) {
        if (observation.source.kind !== 'client' || observation.source.tool !== 'api_request:http'
          || observation.basis !== 'observed' || observation.verification !== 'client-observation') continue;
        const refs = observation.evidence.flatMap(ref => {
          const file = posix.basename(ref.path), match = /^(run-[A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(file);
          // A path from editable metadata never becomes a filesystem action.
          // Only the exact selected stack's direct receipt name is navigable.
          return match && ref.path === posix.join(scope.evidenceDir, file) ? [{ ref, runId: match[1] }] : [];
        });
        const selected = refs.find(item => item.ref.state === 'matching') ?? refs[0];
        const evidenceState = selected?.ref.state === 'matching' ? 'available' : selected?.ref.state ?? 'unavailable';
        items.push({ observation_id: observation.id, run_id: selected?.runId ?? null,
          observed_at: observation.observed_at, status: observation.response_status ?? null,
          scope: { stack, environment: identity.environment, provider: identity.provider,
            protocol: identity.protocol, contract_digest: identity.contractDigest },
          assertions: observation.assertions ?? null, verification: observation.verification, outcome: observation.outcome,
          evidence: { state: evidenceState, code: evidenceState === 'available' ? null
            : evidenceState === 'changed' ? 'EVIDENCE_CHANGED' : evidenceState === 'unchecked' ? 'EVIDENCE_UNCHECKED'
              : evidenceState === 'missing-or-unavailable' ? 'EVIDENCE_MISSING_OR_UNAVAILABLE' : 'EVIDENCE_UNAVAILABLE' },
          in_current_scope: currentScope?.state === 'bound' && identity.provider === currentScope.provider
            && identity.environment === currentScope.environment && identity.contractDigest === currentScope.contract_digest });
      }
    }
    items.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || a.observation_id.localeCompare(b.observation_id));
    const shown = items.slice(0, 50), incomplete = saved.omissions.operations > 0 || saved.issues.length > 0;
    return { state: incomplete ? items.length ? 'partial' : 'unavailable' : 'available',
      total: items.length, shown: shown.length, omitted: items.length - shown.length,
      history_omitted: historyOmitted, scopes_omitted: saved.omissions.operations,
      current_scope_count: operation.responses ?? 0, issues: saved.issues.map(issue => ({ code: issue.code })), items: shown,
      basis: 'Retained client observations in this stack, newest first, across the shown environment and contract scopes. At most 50 response summaries are shown; totals cover only scopes returned within the context read bound, with older retention and omitted scopes counted separately. Current-scope counts use the API map rules; old scopes, missing evidence and failed responses are not current verification. Assertions are known only when recorded on the observation. Private bodies open only after explicit Send or Inspect actions.' };
  });
}

/**
 * Show requests from an agent's api_workbench show, validated against the
 * ledger before they reach the paired tab as a dismissible banner. The queue
 * holds the newest five for an hour; the browser navigates only on a click.
 */
export function createShowQueue(root, { now = Date.now, bound = 5, ttlMs = 60 * 60 * 1000 } = {}) {
  const requests = [];
  const prune = () => { const cutoff = now() - ttlMs; while (requests.length && Date.parse(requests[0].at) < cutoff) requests.shift(); };
  return Object.freeze({
    push(session) {
      const ledger = buildSessionLedger(root, { now: now(), attentionBound: 1 });
      const found = ledger.sessions.find(entry => entry.id === session);
      if (!found) throw Object.assign(new Error('No recorded session has that id.'), { code: 'WORKBENCH_SESSION_UNKNOWN' });
      const summary = summarizeLedgerSession(found, ledger);
      prune();
      const request = { request_id: `show-${randomUUID()}`, session, at: new Date(now()).toISOString(), line: summary.line,
        calls: summary.calls, failed: summary.failed, notes: summary.notes };
      requests.push(request);
      while (requests.length > bound) requests.shift();
      return { queued: true, request_id: request.request_id };
    },
    list() { prune(); return requests.map(request => ({ ...request })); },
  });
}

export function workbenchHandlers(root, { sessionId = `wb-${randomUUID()}`, shows = null } = {}) {
  // The terminal's inbox belongs to this repository, not to an MCP peer.
  // Presence is best-effort metadata and cannot grant or revoke an action.
  // The rail's "latest agent session" rides on the presence poll. The ledger
  // read is bounded by a short cache so polling never rereads every run file.
  let latestSessionCache = { at: 0, value: null };
  function latestSession(now = Date.now()) {
    if (now - latestSessionCache.at < LATEST_SESSION_CACHE_MS) return latestSessionCache.value;
    let value = null;
    try { value = latestAgentSession(buildSessionLedger(root, { now, attentionBound: 1 })); } catch { value = null; }
    latestSessionCache = { at: now, value };
    return value;
  }
  async function agentStatus({ limit = 20, presenceLimit = 32 } = {}) {
    let presence;
    try { presence = await listWorkbenchAgents(root, { limit: presenceLimit }); }
    catch { presence = { agents: [], unavailable: 1 }; }
    const first = readWorkbenchHandoff(root, sessionId, { limit: 1 });
    const { agents, stale_after_ms, ...presenceStatus } = presence;
    return { ...readWorkbenchHandoff(root, sessionId, { after: first.acknowledged_through, limit }),
      session_id: sessionId, agents, stale_after_ms, presence: presenceStatus, connection: agents[0] ?? null,
      latest_session: latestSession(), show_requests: shows ? shows.list() : [] };
  }
  const guard = fn => async params => {
    try {
      return await fn(params);
    }
    catch (error) {
      if (error instanceof WorkbenchRefusal) throw error;
      if (typeof error.code === 'string' && error.code.startsWith('WORKBENCH_HANDOFF_'))
        throw new WorkbenchRefusal(error.code, error.message);
      const refusal = savedActionFailure(error).error;
      const next = typeof error.input === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(error.input)
        ? `Repair runtime input '${error.input}' and explicitly send again.` : refusal.next;
      throw new WorkbenchRefusal(refusal.code, refusal.message ? `${refusal.message} ${next}` : next);
    }
  };
  const digest = document => document ? createHash('sha256').update(JSON.stringify(document)).digest('hex') : undefined;
  const identity = document => document?.request && typeof document.request.method === 'string' && typeof document.request.path === 'string'
    ? { stack: document.stack, environment: document.environment,
      operation: `${document.request.method} ${document.request.path}`, ...(document.id ? { request_id: document.id } : {}) } : {};
  function record(event) {
    try {
      const value = appendWorkbenchEvent(root, sessionId, Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)));
      return { state: 'queued', session_id: sessionId, event_id: value.event_id, seq: value.seq };
    } catch (error) {
      // Recording failure must not disguise a completed write as a refused
      // request. Evidence/recipe remains authoritative; do not repeat the send.
      return { state: 'not_queued', session_id: sessionId,
        code: /^[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'WORKBENCH_HANDOFF_UNAVAILABLE',
        next: 'The action result below is retained. Tell your agent the handoff could not be recorded; do not repeat a send to repair the inbox.' };
    }
  }
  async function savedAction(params) {
    if (!['create', 'edit', 'rename', 'delete', 'run'].includes(params?.action))
      return savedRequestAction(root, params, { browser: true, initiator: 'workbench.request' });
    let before = null;
    if (params.ref) {
      // The journal's preimage is advisory. Let the actual action validate its
      // complete envelope first, preserving the dispatcher's precise refusal.
      try { before = (await savedRequestAction(root, { action: 'show', ref: params.ref }, { browser: true })).document; }
      catch { /* the requested action still performs its own validation */ }
    }
    let result;
    try { result = await savedRequestAction(root, params, { browser: true, initiator: 'workbench.request' }); }
    catch (error) {
      if (params.action === 'run') record({ kind: 'request_result', ...identity(before ?? params.document), saved_ref: params.ref,
        error_code: savedActionFailure(error).error.code });
      throw error;
    }
    const document = result.document ?? before ?? params.document;
    const event = { kind: { create: 'saved', edit: 'edited', rename: 'renamed', delete: 'deleted', run: 'request_result' }[params.action],
      ...identity(document), saved_ref: result.ref ?? params.ref,
      ...(params.action === 'rename' ? { previous_ref: params.ref } : {}),
      request_digest: digest(document), ...(before ? { previous_request_digest: digest(before) } : {}) };
    if (params.action === 'run') {
      event.run_id = typeof result.evidence === 'string' ? result.evidence : result.saved_request?.run_id;
      event.status = Number.isInteger(result.status) ? result.status : undefined;
      event.error_code = result.error?.code;
    }
    return { ...result, handoff: record(event) };
  }
  return {
    ...reviewHandlers(root),
    // The design page's views: the note index, one note's trace, the survey
    // Map, local appearance and responses saved outside the ledger.
    workbench: { touch: true, run: guard(params => { exact(params, []); return workbenchIndex(root); }) },
    note: { touch: true, run: guard(params => workbenchNote(root, params)) },
    // One operation on the Workbench, notes or not. The older `operation`
    // action below keeps its own shape for its existing readers.
    operationView: { touch: true, run: guard(params => workbenchOperation(root, params)) },
    surveyMap: { touch: true, run: guard(params => { exact(params, []); return workbenchMap(root); }) },
    appearance: { touch: true, run: guard(params => setAppearance(root, params)) },
    respond: { touch: true, run: guard(params => addResponse(root, params)) },
    // The page's one ledger write: a person-authored operation note.
    addNote: { touch: true, run: guard(params => addNote(root, params)) },
    agent: guard(params => { exact(params, []); return agentStatus(); }),
    handoff: { touch: true, run: guard(params => {
      exact(params, ['message', 'stack', 'environment', 'operation', 'saved_ref', 'run_id']);
      const event = appendWorkbenchEvent(root, sessionId, { ...params, kind: 'follow_up' });
      return { state: 'queued', event_id: event.event_id, seq: event.seq, session_id: sessionId,
        next: 'Ask your agent to pick up the workbench handoff. Queuing it does not wake an idle model.' };
    }) },
    map: { touch: true, run: guard(params => { exact(params, []); return buildWorkbenchMap(root); }) },
    snapshot: guard(async params => {
      exact(params, []);
      // An unreadable inbox must not hide stacks or prevent independent actions.
      let agent;
      // Five bounded inbox events and eight UTF-8 presence labels fit the
      // 64-KiB reserve above workbenchSnapshot's own budget. The separate agent
      // poll retains its wider presence limit; omitted records remain counted.
      try { agent = await agentStatus({ limit: 5, presenceLimit: 8 }); }
      catch { agent = { session_id: sessionId, connection: null, agents: [], inbox_unavailable: true }; }
      return { ...await workbenchSnapshot(root), agent };
    }),
    settings: { touch: true, run: guard(params => setSettings(root, params)) },
    operation: { touch: true, run: guard(params => {
      exact(params, ['stack', 'operation']);
      const found = views(buildViewModel(root)).find(view => view.name === params.stack)?.model;
      const operation = found?.operations.find(row => row.op === params.operation);
      if (!operation) throw new WorkbenchRefusal('WORKBENCH_OPERATION_MISSING', 'Refresh the API index and choose a retained operation.');
      return clean({ stack: params.stack, contract: found.contract, contract_state: found.contract_state,
        operation, notes_omitted: Math.max(0, (operation.notes?.length ?? 0) - 50),
        ...{ operation: { ...operation, recorded_responses: recordedResponses(root, params.stack, operation, found.api_map?.scope), notes: operation.notes?.slice(0, 50), fields: operation.fields?.slice(0, 100), declared: operation.declared?.slice(0, 100) } } });
    }) },
    saved: { touch: true, run: guard(savedAction) },
    inspect: { touch: true, run: guard(params => { exact(params, ['stack', 'runId']); return inspectRecordedResponse(root, params); }) },
    // The session view: a ledger session id only, never a path or a token.
    session: { touch: true, run: guard(params => {
      exact(params, ['session']);
      try { return clean(workbenchSessionModel(root, params.session)); }
      catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('WORKBENCH_SESSION_')) throw new WorkbenchRefusal(error.code, error.next);
        throw error;
      }
    }) },
  };
}

export function workbenchAssets() {
  const read = name => readFileSync(new URL(`./workbench/${name}`, import.meta.url), 'utf8');
  return new Map([
    ['/', { body: read('index.html').replaceAll('__PRODUCT__', PROSE_PRODUCT_TITLE), contentType: 'text/html; charset=utf-8' }],
    ['/workbench.js', { body: read('workbench.js'), contentType: 'text/javascript; charset=utf-8' }],
    ['/workbench.css', { body: read('workbench.css'), contentType: 'text/css; charset=utf-8' }],
  ]);
}
