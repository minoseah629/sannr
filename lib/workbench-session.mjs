// SESSION-1 part 3: the Workbench's session view model. One ledger session
// (normally one MCP host process) with the fixed summary, what it changed in
// the knowledge files as a diff drawn from note history (so committed and
// uncommitted changes read the same), its attention items, its call rows and
// whether the project directory has uncommitted changes.
//
// Reads local files only; sends nothing. The model carries note text, which
// is committed guidance that already passed the secret scan when it was
// written, plus names, counts, ids and timestamps. No request URL, body,
// header or captured value is read into it, and `git status` contributes a
// count, never a path.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CONTEXT_BASENAME } from './brand.mjs';
import { LAYOUT } from './layout.mjs';
import { stackCatalog } from './stacks.mjs';
import { inspectNoteHistory } from './note-history.mjs';
import { buildSessionLedger, SESSION_ROW_BOUND } from './session-ledger.mjs';
import { summarizeLedgerSession } from './session-summary.mjs';
import { operationAnchor } from './operation-anchor.mjs';
import { secretIn } from './verdicts.mjs';

/** A ledger session id: a process, a build-and-day or a host-and-day key. */
export const SESSION_ID = /^(?:process:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|build:[a-f0-9-]{36}:[a-z._]{1,40}:\d{4}-\d{2}-\d{2}|day:[a-z._]{1,40}:(?:\d{4}-\d{2}-\d{2}|date not recorded))$/;
const CHANGE_BOUND = 200;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const RUN = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refusal = (code, next) => Object.assign(new Error(next), { code, next });

// Notes citing this session's runs, grouped by stack and operation. A note
// that supersedes another is a correction and carries the superseded record;
// everything else is an addition. Source: note history, not git.
function sessionChanges(root, catalog, runIds) {
  const stacks = [], unavailable = [];
  let added = 0, corrected = 0, omitted = 0;
  const stores = catalog.stacks.length ? catalog.stacks.map(row => ({ stack: row.name, path: join(row.folder, CONTEXT_BASENAME) }))
    : [{ stack: null, path: join(root, LAYOUT.context) }];
  const cited = refs => (Array.isArray(refs) ? refs : []).map(ref => typeof ref?.run_id === 'string' && RUN.test(ref.run_id) ? ref.run_id : null)
    .filter(run => run && runIds.has(run));
  const shown = (text, max = 1000) => typeof text === 'string' && !secretIn(text) ? text.slice(0, max) : 'withheld';
  const record = (entry, item) => ({ id: entry.id, text: shown(entry.text), by: entry.provenance?.by ?? null, at: entry.provenance?.at ?? null, ...item });
  for (const store of stores) {
    let ctx;
    try {
      const text = readFileSync(store.path, 'utf8');
      if (text.length > MAX_STORE_BYTES) { unavailable.push({ stack: store.stack, code: 'KNOWLEDGE_BEYOND_READ_BOUND' }); continue; }
      ctx = JSON.parse(text);
    } catch (error) { if (error.code !== 'ENOENT') unavailable.push({ stack: store.stack, code: 'KNOWLEDGE_UNREADABLE' }); continue; }
    if (!object(ctx)) { unavailable.push({ stack: store.stack, code: 'KNOWLEDGE_UNREADABLE' }); continue; }
    const operations = [];
    const inspect = (entry, operation) => {
      let history;
      try { history = inspectNoteHistory(entry); } catch { unavailable.push({ stack: store.stack, code: 'NOTE_HISTORY_INVALID', operation }); return; }
      const byId = new Map(history.records.map(item => [item.id, item]));
      // The replacement side of each authored supersession, by replacement id.
      const replaced = new Map();
      for (const item of history.records) if (item.superseded?.kind === 'authored' && typeof item.superseded.replacement === 'string') replaced.set(item.superseded.replacement, item);
      const items = [];
      for (const item of history.records) {
        if (item.kind === 'machine') continue;
        const evidence = cited(item.provenance?.evidence);
        if (!evidence.length) continue;
        const original = replaced.get(item.id) ?? null;
        if (items.length + operations.reduce((n, op) => n + op.items.length, 0) >= CHANGE_BOUND) { omitted += 1; continue; }
        if (original) { corrected += 1; items.push(record(item, { kind: 'corrected', evidence, superseded: record(byId.get(original.id) ?? original, {}), superseded_at: original.superseded?.at ?? null })); }
        else { added += 1; items.push(record(item, { kind: 'added', evidence, superseded: null })); }
      }
      if (items.length) operations.push({ operation, operation_anchor: operation === null ? null : operationAnchor({ stack: store.stack, operation }), items });
    };
    for (const [key, entry] of Object.entries(object(ctx.operations) ? ctx.operations : {})) if (object(entry) && typeof key === 'string' && key.length <= 512 && !secretIn(key)) inspect(entry, key);
    if (object(ctx.stack_facts)) inspect(ctx.stack_facts, null);
    if (operations.length) stacks.push({ stack: store.stack, operations });
  }
  return { stacks, added, corrected, omitted, unavailable,
    basis: 'Notes whose evidence cites a run of this session, read from note history in the knowledge files; committed and uncommitted changes read the same. Lessons saved without evidence are not attributable to a session.' };
}

// Whether the project directory has uncommitted changes. A count only: paths
// never leave this function. Not a git repository, or no git, reads unavailable.
export function projectDirectoryState(root, { run = spawnSync } = {}) {
  let result;
  try { result = run('git', ['status', '--porcelain', '--untracked-files=all', '--', LAYOUT.directory], { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { result = null; }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return { state: 'unavailable', changed: null, directory: LAYOUT.directory, basis: 'git status could not be read here; this is not a git repository, or git is unavailable.' };
  const changed = result.stdout.split('\n').filter(line => line.trim()).length;
  return { state: changed ? 'uncommitted' : 'clean', changed, directory: LAYOUT.directory,
    basis: changed ? `git status lists ${changed} changed or untracked ${changed === 1 ? 'path' : 'paths'} under ${LAYOUT.directory}; commit them so the knowledge travels.` : `git status lists no changes under ${LAYOUT.directory}.` };
}

// The ledger keeps the newest rows up to the bound; a batch block is never split.
function boundRows(all, bound) {
  const shown = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const size = all[i].kind === 'batch' ? Math.max(1, all[i].rows.length) : 1;
    if (used + size > bound && shown.length) break;
    shown.unshift(all[i]); used += size;
  }
  const count = list => list.reduce((n, row) => n + (row.kind === 'batch' ? row.rows.length : 1), 0);
  return { rows: shown, rows_shown: count(shown), rows_omitted: count(all) - count(shown) };
}

/** The session view model for one ledger session id. */
export function workbenchSessionModel(root, id, { env = process.env, now = Date.now(), rowBound = SESSION_ROW_BOUND, run } = {}) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw refusal('WORKBENCH_SESSION_ID_INVALID', 'Open a session from Activity or the agent’s summary; the id is a ledger session id.');
  const ledger = buildSessionLedger(root, { env, now, rowBound: Number.MAX_SAFE_INTEGER, attentionBound: 200 });
  const session = ledger.sessions.find(entry => entry.id === id);
  if (!session) throw refusal('WORKBENCH_SESSION_UNKNOWN', 'No recorded session has that id in this repository’s ledger. Refresh Activity and choose a listed session.');
  let catalog;
  try { catalog = stackCatalog(root); } catch { catalog = { stacks: [] }; }
  const runIds = new Set(session.rows.flatMap(row => row.kind === 'batch' ? row.rows : [row]).map(row => row.basis?.run_id).filter(Boolean));
  const attention = (ledger.needs_attention?.groups ?? []).flatMap(group => group.items.filter(item => item.session_id === id).map(item => ({ ...item, kind: item.kind ?? group.kind })));
  const { rows, rows_shown, rows_omitted } = boundRows(session.rows, rowBound);
  return {
    session: { id: session.id, grouping: session.grouping, grouping_basis: session.grouping_basis, local_day: session.local_day, hosts: session.hosts,
      build_id: session.build_id, package_version: session.package_version, started_at: session.started_at, ended_at: session.ended_at, stacks: session.stacks, totals: session.totals },
    summary: summarizeLedgerSession(session, ledger),
    changes: sessionChanges(root, catalog, runIds),
    attention: { items: attention, total: attention.length, ledger_omitted: ledger.needs_attention?.omitted ?? 0,
      basis: 'Recorded failures, drift, refusals and leftovers attributed to this session; merged per request by the view.' },
    rows, rows_shown, rows_omitted,
    repository: projectDirectoryState(root, run ? { run } : {}),
    sources: ledger.sources,
  };
}
