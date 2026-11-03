// The session ledger, rendered: a terminal table for a person at a prompt and
// the HTML section the view page and `sessions --out` share. Both read only the
// model from lib/session-ledger.mjs; neither reads a file or computes a count.
import { escapeText, withheldSentence } from './api-map.mjs';
import { terminalText } from './terminal.mjs';
import { relativeViewHref } from './operation-anchor.mjs';

const esc = escapeText;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad2 = n => String(n).padStart(2, '0');
// Local wall-clock time, the same zone the session's local day uses.
const clock = iso => { if (!iso) return 'time n/r'; const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const stamp = iso => { if (!iso) return 'not recorded'; const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(iso)}`; };
const short = id => typeof id === 'string' ? id.replace(/^(process|build|day):/, '') : '';

/** The call's operation as shown: the stored key, or the method when no key was resolved. */
export function operationLabel(row) {
  if (row.operation) return row.operation;
  const verb = row.method ?? (row.protocol && row.protocol !== 'http' ? row.protocol : null);
  return verb ? `${verb} (operation not resolved)` : 'operation not recorded';
}
const statusLabel = row => row.status ?? (row.left.refusal ? 'not sent' : row.left.error ? 'no response' : 'not recorded');
const assertionLabel = row => row.assertions ? `${row.assertions.passed} passed, ${row.assertions.failed} failed` : 'not recorded';
const knownLabel = row => row.delivered.notes === null ? 'delivery not recorded' : plural(row.delivered.notes, 'note');
export function producedParts(row) {
  const p = row.produced, parts = [];
  if (p.observation) parts.push('observation');
  if (p.drift.length) parts.push(`${plural(p.drift.length, 'drift record')} (${p.drift.join(', ')})`);
  for (const draft of p.drafts) parts.push(`draft proposed (${draft.reason})`);
  if (p.notes_written.length) parts.push(`${plural(p.notes_written.length, 'note')} written`);
  if (p.key_source_links) parts.push(plural(p.key_source_links, 'key-source link'));
  return parts;
}
export function leftParts(row) {
  const parts = [];
  if (row.left.refusal) parts.push(`refused ${row.left.refusal} (attempted ${row.left.attempted ?? 0})`);
  if (row.left.error) parts.push(row.left.error === 'UNRESOLVED_PLACEHOLDER' ? 'unresolved placeholder (UNRESOLVED_PLACEHOLDER)' : `error ${row.left.error}`);
  return parts;
}
// Every row names what it rests on: the run file, and the draft and note ids it produced.
export const basisIds = row => [row.basis.run_id ?? (row.basis.expected_run_id ? `receipt missing: ${row.basis.expected_run_id}` : 'no run file'),
  ...(row.basis.envelope_id ? [row.basis.envelope_id] : []), ...row.produced.drafts.map(draft => draft.id), ...row.produced.notes_written];
const basisOf = row => basisIds(row).join(', ');

function totalsSentence(t) {
  const classes = Object.entries(t.status_classes).filter(([, n]) => n).map(([key, n]) => `${n} ${key}`).join(', ');
  return [
    `${plural(t.calls, 'call')}${classes ? ` (${classes})` : ''}`,
    `assertions ${t.assertions.passed} passed, ${t.assertions.failed} failed`,
    `notes delivered ${t.notes_delivered}${t.delivery_not_recorded ? ` (delivery not recorded for ${plural(t.delivery_not_recorded, 'call')})` : ''}`,
    `notes written ${t.notes_written}`, `observations ${t.observations_captured}`, `drift records ${t.drift_records}`,
    `drafts proposed ${t.drafts_proposed}`, `refusals ${t.refusals}`, `left behind ${t.leftovers}`,
    ...(t.unresolved_placeholders ? [`unresolved placeholders ${t.unresolved_placeholders}`] : []),
    ...(t.errors_without_response ? [`errors without a response ${t.errors_without_response}`] : []),
  ].join(' · ');
}
const tokenSentence = t => t.envelope_tokens.calls_measured
  ? `Envelope tokens: ${t.envelope_tokens.estimate} over ${plural(t.envelope_tokens.calls_measured, 'call')} (${t.envelope_tokens.label}).`
  : `Envelope tokens: not measured for these calls (${t.envelope_tokens.label}).`;

function basisSentence(model) {
  const s = model.sources;
  const dirs = s.evidence_directories.length ? s.evidence_directories.join(', ') : 'none present';
  const issues = [s.unreadable_files ? `${plural(s.unreadable_files, 'file')} unreadable` : '',
    s.files_beyond_read_bound ? `${plural(s.files_beyond_read_bound, 'file')} beyond the read bound` : '',
    s.unsafe_directories ? `${plural(s.unsafe_directories, 'directory', 'directories')} refused as unsafe` : ''].filter(Boolean);
  return `Basis: local files only; no request made. Evidence directories: ${dirs}; ${plural(s.run_files, 'run file')}, ${plural(s.envelope_records, 'envelope outcome record')}, ${plural(s.draft_records, 'draft record')}, ${plural(s.knowledge_files, 'knowledge file')}; usage log rows matched by run id: ${s.usage_log.rows_matched_by_run}.` +
    (s.usage_log.project_rows_without_evidence ? ` ${plural(s.usage_log.project_rows_without_evidence, 'usage-log row')} for this project name ${s.usage_log.project_rows_without_evidence === 1 ? 'has' : 'have'} no run file here and ${s.usage_log.project_rows_without_evidence === 1 ? 'is' : 'are'} not listed.` : '') +
    (issues.length ? ` Not read: ${issues.join('; ')}.` : '') +
    (model.filters.since || model.filters.stack ? ` Filters: ${[model.filters.since ? `since ${model.filters.since}` : '', model.filters.stack ? `stack ${model.filters.stack}` : ''].filter(Boolean).join(', ')}.` : '');
}
const sessionTitle = (session, index) => `Session ${index + 1} · ${session.grouping === 'process' ? `process ${short(session.id).slice(0, 8)}` : session.grouping === 'build-and-day' ? `build ${String(session.build_id).slice(0, 8)}, ${session.local_day}` : `by day ${session.local_day}`} · host ${session.hosts.join(', ')} · ${stamp(session.started_at)} to ${stamp(session.ended_at)} · stacks ${session.stacks.join(', ') || 'none recorded'}`;
const omission = session => session.rows_omitted ? `${plural(session.rows_omitted, 'earlier row')} omitted by the ${session.rows_shown}-row bound; the totals include them.` : '';

const attentionBasis = item => Object.entries(item.basis).filter(([, value]) => value !== null && value !== undefined)
  .map(([key, value]) => `${key}: ${value}`).join('; ') || 'basis not recorded';
const attentionScope = item => `session ${item.session_id ?? 'unknown'} · stack ${item.stack ?? 'not recorded'} · ${operationLabel(item)}`;
function safeHref(value) {
  if (typeof value !== 'string') return null;
  if (/^operation-[a-f0-9]{64}$/.test(value)) return `#${value}`;
  const match = /^(.*)#(operation-[a-f0-9]{64})$/.exec(value);
  if (!match) return null;
  const path = relativeViewHref(match[1]);
  return path ? `${path}#${match[2]}` : null;
}
const operationHtml = (row, links) => {
  const label = `<code>${esc(operationLabel(row))}</code>`, href = safeHref(links(row));
  return href ? `<a href="${esc(href)}">${label}</a>` : label;
};

export function renderSessionAttentionText(attention) {
  if (!attention) return 'Needs attention — unavailable: this ledger has no attention projection.';
  const lines = [`Needs attention — ${attention.total} recorded items; ${attention.shown} shown; state ${attention.state}`, attention.basis];
  if (attention.empty) lines.push(attention.empty);
  for (const group of attention.groups) {
    lines.push(`${group.title}: ${group.total}${group.omitted ? ` (${group.omitted} omitted by the ${attention.bound}-item bound)` : ''}`);
    for (const item of group.items) lines.push(`  ${stamp(item.at)} · ${attentionScope(item)} · ${item.summary} Basis: ${attentionBasis(item)}.`);
  }
  lines.push(...attention.unknowns);
  return lines.map(terminalText).join('\n');
}

export function renderSessionAttentionHtml(attention, { links = () => null } = {}) {
  if (!attention) return '<section id="needs-attention"><h2>Needs attention</h2><p>Unavailable: this ledger has no attention projection.</p></section>';
  return `<section id="needs-attention" class="am"><h2>Needs attention</h2><p>${esc(`${attention.total} recorded items; ${attention.shown} shown; state ${attention.state}.`)}</p>` +
    `<p class="am-basis">${esc(attention.basis)}</p>${attention.empty ? `<p>${esc(attention.empty)}</p>` : ''}` +
    attention.groups.map(group => `<details><summary>${esc(group.title)} · ${group.total}${group.omitted ? ` · ${group.omitted} omitted` : ''}</summary>` +
      (group.omitted ? `<p class="am-basis">${esc(`${group.omitted} ${group.title.toLowerCase()} items omitted by the ${attention.bound}-item bound.`)}</p>` : '') +
      (group.items.length ? `<ul>${group.items.map(item => `<li>${esc(stamp(item.at))} · stack ${esc(item.stack ?? 'not recorded')} · ${operationHtml(item, links)}<p>${esc(item.summary)}</p><p class="am-basis">Session: <code>${esc(item.session_id ?? 'unknown')}</code>. Basis: ${esc(attentionBasis(item))}.</p></li>`).join('')}</ul>` : '') + '</details>').join('') +
    `<p class="am-basis">${esc(attention.unknowns.join(' '))}</p></section>`;
}

// --- terminal ------------------------------------------------------------------

export function renderSessionLedgerText(model) {
  const t = terminalText;
  const lines = [`Sessions — ${plural(model.totals.sessions, 'session')}, ${plural(model.totals.calls, 'call')}, newest first`, t(basisSentence(model)), '', renderSessionAttentionText(model.needs_attention)];
  if (model.empty) {
    lines.push('', model.empty.reason === 'filtered-out' ? t(model.empty.populate) : `No calls recorded yet. ${t(model.empty.populate)}`);
    return lines.join('\n');
  }
  const header = ['time', 'stack', 'operation', 'status', 'assertions', 'known', 'produced', 'left', 'basis'];
  const cells = (row, prefix = '') => [`${prefix}${clock(row.at)}`, row.stack ?? '-', operationLabel(row), String(statusLabel(row)),
    assertionLabel(row), knownLabel(row), producedParts(row).join('; ') || '-', leftParts(row).join('; ') || '-', basisOf(row)].map(t);
  model.sessions.forEach((session, index) => {
    lines.push('', t(sessionTitle(session, index)), `  ${t(session.grouping_basis)}`);
    // A batch is one block: its own line, then its steps, cleanup marked.
    const table = [header];
    for (const row of session.rows) {
      if (row.kind === 'batch') {
        table.push(t(`batch ${row.envelope_id} · stack ${row.stack ?? 'per step'} · attempted ${row.attempted ?? 'not recorded'}${row.stopped_early ? ', stopped early' : ''}` +
          `${row.refusal ? ` · refused ${row.refusal} (attempted ${row.attempted ?? 0})` : ''} · left behind ${row.left_behind ?? 'not recorded'}`));
        for (const step of row.rows) table.push(cells(step, step.phase === 'cleanup' ? 'cleanup ' : '  '));
      } else table.push(cells(row));
    }
    const rows = table.filter(Array.isArray), limits = [18, 16, 40, 10, 20, 22, 40, 48];
    const widths = limits.map((limit, i) => Math.min(limit, Math.max(...rows.map(r => r[i].length))));
    const fit = (text, width) => text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
    for (const row of table) lines.push(Array.isArray(row) ? `  ${row.map((cell, i) => i === row.length - 1 ? cell : fit(cell, widths[i])).join('  ')}`.trimEnd() : `  ${row}`);
    if (session.rows_omitted) lines.push(`  ${omission(session)}`);
    lines.push(`  Totals: ${totalsSentence(session.totals)}`, `  ${tokenSentence(session.totals)}`);
  });
  lines.push('', `Over the listed range: ${plural(model.totals.sessions, 'session')} · ${totalsSentence(model.totals)}`, tokenSentence(model.totals),
    'Token figures are the client\'s own envelope sizes divided by four; they are not a savings claim.');
  const withheld = withheldSentence(model.withheld);
  if (withheld) lines.push(t(withheld));
  return lines.join('\n');
}

// --- HTML section ----------------------------------------------------------------

/**
 * The ledger section. `links(row)` returns a generated operation anchor, or a
 * safe relative report path plus that anchor; null keeps the inline basis.
 */
export function renderSessionLedgerHtml(model, { links = () => null } = {}) {
  const head = `<section id="sessions" class="am" aria-labelledby="sessions-title"><h2 id="sessions-title">Sessions</h2><p class="am-basis">${esc(basisSentence(model))}</p>`;
  if (model.empty) return `${head}<p>${esc(model.empty.reason === 'filtered-out' ? model.empty.populate : `No calls recorded yet. ${model.empty.populate}`)}</p></section>`;
  const tile = (value, label) => `<div class="am-tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const tiles = t => `<div class="am-tiles">${tile(t.calls, 'calls')}${tile(`${t.assertions.passed} / ${t.assertions.failed}`, 'assertions passed / failed')}${tile(t.notes_delivered, 'notes delivered')}${tile(t.notes_written, 'notes written')}${tile(t.drift_records, 'drift records')}${tile(t.drafts_proposed, 'drafts proposed')}${tile(t.refusals, 'refusals')}${tile(t.leftovers, 'left behind')}</div>`;
  const op = row => operationHtml(row, links);
  const list = parts => parts.length ? parts.map(esc).join('<br>') : '—';
  const tr = (row, prefix = '') => `<tr><td class="am-nw">${esc(prefix)}${esc(clock(row.at))}</td><td>${esc(row.stack ?? '—')}</td><td>${op(row)}</td><td>${esc(statusLabel(row))}</td><td>${esc(assertionLabel(row))}</td><td>${esc(knownLabel(row))}</td><td>${list(producedParts(row))}</td><td>${list(leftParts(row))}</td><td><code>${esc(basisOf(row))}</code></td></tr>`;
  const sessions = model.sessions.map((session, index) => {
    const body = session.rows.map(row => row.kind === 'batch'
      ? `<tr><td colspan="9"><b>Batch</b> <code>${esc(row.envelope_id)}</code>: attempted ${esc(row.attempted ?? 'not recorded')}${row.stopped_early ? ', stopped early' : ''}${row.refusal ? `; refused ${esc(row.refusal)} (attempted ${esc(row.attempted ?? 0)})` : ''}; left behind ${esc(row.left_behind ?? 'not recorded')}.</td></tr>` +
        row.rows.map(step => tr(step, step.phase === 'cleanup' ? 'cleanup · ' : '↳ ')).join('')
      : tr(row)).join('');
    return `<details open><summary>${esc(sessionTitle(session, index))}</summary><p class="am-basis">${esc(session.grouping_basis)} Host telemetry: not recorded.</p>` +
      tiles(session.totals) +
      `<div class="am-scroll"><table class="am-wide"><thead><tr><th>time</th><th>stack</th><th>operation</th><th>status</th><th>assertions</th><th>known</th><th>produced</th><th>left</th><th>basis</th></tr></thead><tbody>${body}</tbody></table></div>` +
      (session.rows_omitted ? `<p class="am-basis">${esc(omission(session))}</p>` : '') +
      `<p class="am-basis">${esc(`Totals: ${totalsSentence(session.totals)}. ${tokenSentence(session.totals)}`)}</p></details>`;
  }).join('\n');
  return `${head}<h3>Over the listed range</h3>${tiles(model.totals)}<p class="am-basis">${esc(`${plural(model.totals.sessions, 'session')} · ${totalsSentence(model.totals)}. ${tokenSentence(model.totals)} Token figures are the client's own envelope sizes divided by four; they are not a savings claim.`)}</p>\n${sessions}</section>`;
}
