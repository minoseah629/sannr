// SESSION-1: the session summary an agent can quote at the end of a task.
// One MCP server process is one session in the ledger (origin.session_id on
// every run file it writes). This projects that session's totals from the
// same ledger model `sessions --json` renders. The Workbench uses this same
// summary; the ledger also exposes separate aggregate metrics. Counts come
// from recorded files only,
// never from what the agent says it did; where the record cannot attribute
// something, the field says "not recorded" and is never rounded to zero.
//
// It needs no running Workbench, no pairing and no attachment, reads only
// local files and sends nothing. The model carries counts, ids and timestamps;
// no request URL, body, header or captured value is read into it.
import { PROSE_PRODUCT_TITLE } from './brand.mjs';
import { PROCESS_SESSION_ID } from './note-evidence.mjs';
import { buildSessionLedger } from './session-ledger.mjs';
import { advertisementPlan } from './advertisement.mjs';

export const NOT_RECORDED = 'not recorded';
// Successful in-process writes are a completeness check only. A saved lesson
// without durable session attribution cannot become an extra numeric count.
const WRITTEN_KEY = /^(?:sha256:[a-f0-9]{64}|observation:[A-Za-z0-9][A-Za-z0-9:._-]{0,511})$/;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The fixed wording the skill tells the agent to paste rather than paraphrase. */
export function summaryLine({ calls, failed, notes }) {
  const added = notes.added, corrected = notes.corrected;
  const noteText = added === NOT_RECORDED || corrected === NOT_RECORDED ? `notes ${NOT_RECORDED}`
    : added === 0 && corrected === 0 ? 'no notes added'
      : `${plural(added, 'note')} added${corrected > 0 ? `, ${corrected} corrected` : ''}`;
  const requestText = calls === NOT_RECORDED ? `requests ${NOT_RECORDED}` : plural(calls, 'request');
  return `${PROSE_PRODUCT_TITLE}: ${requestText} · ${failed === NOT_RECORDED ? `failures ${NOT_RECORDED}` : `${failed} failed`} · ${noteText}`;
}

/** Use the same verified shim/exact-version npm plan as installed guidance.
 * A source checkout without a portable invocation must not invent a bare
 * executable or promise that its unpublished version is on the registry. */
export function summaryOpen({ root, env = process.env, shown = false } = {}) {
  if (shown) return 'Shown in your Workbench tab';
  const portable = root ? advertisementPlan(root, env).portable : null;
  return portable?.available ? `Open in Workbench: ${portable.command} workbench`
    : 'Open in Workbench: use your installed CLI from a terminal in this repository to run workbench';
}

/** The show action's pointer when no paired tab took the session: the same
 * verified invocation, with --show so the launch lands on the session view.
 * The summary action's own `open` stays as above. */
export function showOpen({ root, env = process.env, target = 'last-session' } = {}) {
  const portable = root ? advertisementPlan(root, env).portable : null;
  return portable?.available ? `Open in Workbench: ${portable.command} workbench --show ${target}`
    : `Open in Workbench: use your installed CLI from a terminal in this repository to run workbench --show ${target}`;
}

/** Every call row of a ledger session, batch blocks flattened. */
export const sessionCallRows = session => session ? session.rows.flatMap(row => row.kind === 'batch' ? row.rows : [row]) : [];

/**
 * The fixed summary fields of one ledger session (null for a process with no
 * recorded call), without `open`. Every caller that shows a summary line goes
 * through here: the summary action, the Workbench rail and snapshot
 * (latest_session) and the session view, so all of them print the same line
 * for the same ledger. `written` lists lessons the summarizing process saved
 * through its own tools ({ id, corrected }); if the durable ledger cannot
 * attribute one, note counts are unknown rather than memory-only.
 */
export function summarizeLedgerSession(session, ledger, { id = session?.id ?? null, written = [] } = {}) {
  const totals = session?.totals ?? null;
  // Notes: the ledger links a note to a run by the evidence the note cites;
  // one id counts once, and a correction is never also an addition.
  const corrected = new Set(), added = new Set();
  for (const row of sessionCallRows(session)) {
    for (const noteId of row.produced.notes_corrected) corrected.add(noteId);
    for (const noteId of row.produced.notes_written) if (!corrected.has(noteId)) added.add(noteId);
  }
  let unattributedWrite = false;
  for (const entry of Array.isArray(written) ? written : []) {
    const key = typeof entry?.id === 'string' && WRITTEN_KEY.test(entry.id) ? entry.id : null;
    if (key && !corrected.has(key) && !added.has(key)) unattributedWrite = true;
  }
  for (const noteId of corrected) added.delete(noteId);
  // A knowledge file or evidence file the ledger could not read may hold a
  // note or run this session wrote; the count is then unknown, not zero.
  const sources = ledger?.sources ?? {};
  const unreadable = sources.unreadable_files > 0 || sources.files_beyond_read_bound > 0 || sources.unsafe_directories > 0;
  const scoped = Object.hasOwn(sources, 'unattributed_incomplete_call_records');
  const callsIncomplete = scoped
    ? sources.unattributed_incomplete_call_records > 0 || sources.incomplete_call_records_by_session?.[id] > 0
    : sources.incomplete_call_records > 0;
  const notesIncomplete = scoped ? sources.incomplete_note_records > 0 : unreadable;
  const notes = notesIncomplete || callsIncomplete || unattributedWrite ? { added: NOT_RECORDED, corrected: NOT_RECORDED } : { added: added.size, corrected: corrected.size };

  const summary = {
    session: id,
    since: session?.started_at ?? null,
    calls: callsIncomplete ? NOT_RECORDED : totals?.calls ?? 0,
    failed: callsIncomplete ? NOT_RECORDED : totals?.calls_failed ?? 0,
    unasserted: callsIncomplete ? NOT_RECORDED : totals?.calls_unasserted ?? 0,
    notes,
    drift: callsIncomplete ? NOT_RECORDED : totals?.drift_records ?? 0,
    refusals: callsIncomplete ? NOT_RECORDED : totals?.refusals ?? 0,
    left_behind: callsIncomplete || totals?.leftovers_not_recorded > 0 ? NOT_RECORDED : totals?.leftovers ?? 0,
  };
  // If this session may have lost receipts, keep its headline unknown.
  // Readable rows remain available as detail, never as a complete summary.
  // These are lower bounds, including retained refusal/envelope rows; absence
  // of a recorded failure is not an all-clear for the unavailable history.
  if (callsIncomplete) summary.recorded = {
    calls: totals?.calls ?? 0, failed: totals?.calls_failed ?? 0,
    unasserted: totals?.calls_unasserted ?? 0, drift: totals?.drift_records ?? 0,
    refusals: totals?.refusals ?? 0,
    basis: 'Some receipts that may belong to this session are missing or unreadable. Recorded counts are lower bounds, not complete totals.',
  };
  summary.line = summaryLine(summary);
  return summary;
}

/** Summarize this host process's own session from the local ledger. */
export function buildSessionSummary(root, { processSessionId = PROCESS_SESSION_ID, env = process.env, now = Date.now(), written = [], shown = false } = {}) {
  const id = `process:${processSessionId}`;
  // Every row of the session is needed for the note identities; the ledger's
  // display bound is for pages, not for counting.
  const ledger = buildSessionLedger(root, { env, now, rowBound: Number.MAX_SAFE_INTEGER, attentionBound: 1 });
  const session = ledger.sessions.find(entry => entry.id === id) ?? null;
  return { ...summarizeLedgerSession(session, ledger, { id, written }), open: summaryOpen({ root, env, shown }) };
}

/** A ledger host that is an MCP server process, as opposed to a CLI run. */
export const AGENT_HOST = /^mcp[.:]/;

/** The newest ledger session whose host is an MCP server process: what the
 * Workbench calls the latest agent session. null when none is recorded. */
export function latestAgentSession(ledger) {
  const session = (ledger?.sessions ?? []).find(entry => (entry.hosts ?? []).some(host => AGENT_HOST.test(host))) ?? null;
  if (!session) return null;
  return { ...summarizeLedgerSession(session, ledger), hosts: session.hosts, started_at: session.started_at, ended_at: session.ended_at,
    stacks: session.stacks, grouping: session.grouping };
}
