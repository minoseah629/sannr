// Survey projections consume a validated snapshot. They never inspect a checkout,
// resolve configuration, refresh observations, or execute a graph renderer.
import { validateSurvey, surveyStatusSummary } from './survey-model.mjs';

const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const quote = value => `"${String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  .replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`;
const json = value => JSON.stringify(value, null, 2);
const compare = (a, b) => String(a).localeCompare(String(b), 'en');
const ordered = values => [...values].sort((a, b) => compare(a.id, b.id));
const stackOf = node => node.stack || '(unbound)';

// The optional status is an independent read receipt, not part of the snapshot.
// Render only its timestamp and known state names; arbitrary diagnostics may
// contain local paths and must not become portable report labels.
function statusLines(snapshot, status) {
  const summary = surveyStatusSummary(status, snapshot.snapshot.id);
  if (!summary.checked_at) return ['current inputs not checked'];
  const lines = [`Current inputs checked: ${summary.checked_at}`, `Overall input status: ${summary.state}`];
  for (const [key, label] of [['source', 'Source/configuration'], ['observations', 'Observation inventory'],
    ['base_commit', 'Git base']]) {
    const state = summary[key]?.state;
    if (state) lines.push(`${label}: ${state}`);
  }
  return lines;
}

function heading(snapshot, status) {
  return [`Snapshot: ${snapshot.snapshot.id}`, `Built: ${snapshot.snapshot.built_at}`, ...statusLines(snapshot, status),
    'Build time is not a freshness assertion.'];
}

function relationshipLabel(edge) {
  const fields = edge.kind === 'supplies'
    ? ` · ${edge.source_field ?? '(source field unavailable)'} → ${edge.target_parameter?.location ?? '?'}:${edge.target_parameter?.name ?? '?'}` : '';
  return `${edge.kind}${fields} · ${edge.declarations.length} declarations / ${edge.observations.length} observations / ${edge.operator_attributions.length} operator attributions`;
}

function groups(nodes) {
  const stacks = new Map();
  for (const node of nodes.filter(node => node.kind === 'operation')) {
    const stack = stackOf(node);
    if (!stacks.has(stack)) stacks.set(stack, []);
    stacks.get(stack).push(node);
  }
  return [...stacks].sort(([a], [b]) => compare(a, b));
}

/** Graphviz text only: no Graphviz process, URL attributes, or external assets. */
export function renderSurveyDot(snapshot, { status } = {}) {
  validateSurvey(snapshot);
  const nodes = ordered(snapshot.nodes), edges = ordered(snapshot.relationships);
  const lines = ['digraph api_survey {', '  graph [rankdir=LR, fontname="sans-serif", labelloc=t,',
    `    label=${quote(heading(snapshot, status).join('\n'))},`,
    `    tooltip=${quote(json({ coverage: snapshot.coverage, unresolved: snapshot.unresolved }))}];`,
    '  node [fontname="sans-serif", shape=box];', '  edge [fontname="sans-serif"];'];
  const nodeLine = node => `${quote(node.id)} [label=${quote(node.label)}, tooltip=${quote(json(node))}];`;
  for (const node of nodes.filter(node => node.kind !== 'operation')) lines.push(`  ${nodeLine(node)}`);
  groups(nodes).forEach(([stack, operations], index) => {
    lines.push(`  subgraph cluster_stack_${index} {`, `    label=${quote(`Stack ${stack}`)};`);
    for (const node of operations) lines.push(`    ${nodeLine(node)}`);
    lines.push('  }');
  });
  for (const edge of edges) lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)} [id=${quote(edge.id)}, label=${quote(relationshipLabel(edge))}, tooltip=${quote(json(edge))}];`);
  return `${lines.join('\n')}\n}\n`;
}

// A deterministic drawing supplements, rather than replaces, the complete
// native disclosure records below. Text clipping affects only the drawing;
// titles and records retain every label and provenance record.
function drawing(nodes, edges) {
  const positions = new Map(), stackBoxes = [];
  const width = 1450, nodeWidth = 286, nodeHeight = 58, gap = 24;
  const columns = [['file', 28], ['operation', 390], ['host', 752], ['contract', 1114]];
  let height = 160;
  for (const [kind, x] of columns) {
    let y = 74;
    if (kind === 'operation') {
      for (const [stack, operations] of groups(nodes)) {
        const top = y;
        y += 32;
        for (const node of operations) { positions.set(node.id, { x, y }); y += nodeHeight + gap; }
        stackBoxes.push({ stack, x: x - 12, y: top, height: y - top - gap + 12 });
        y += 24;
      }
    } else for (const node of nodes.filter(node => node.kind === kind)) {
      positions.set(node.id, { x, y }); y += nodeHeight + gap;
    }
    height = Math.max(height, y + 24);
  }
  const clipped = (text, length = 36) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
  const boxes = stackBoxes.map(box => `<g class="stack-box"><rect x="${box.x}" y="${box.y}" width="${nodeWidth + 24}" height="${box.height}" rx="10"/><text x="${box.x + 12}" y="${box.y + 20}">${esc(clipped(`Stack ${box.stack}`))}</text></g>`).join('');
  const arrows = edges.map(edge => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    let path;
    if (from.x === to.x) {
      const x = from.x + nodeWidth, y1 = from.y + nodeHeight / 2, y2 = to.y + nodeHeight / 2;
      path = edge.from === edge.to
        ? `M ${x} ${y1 - 10} C ${x + 62} ${y1 - 60}, ${x + 62} ${y1 + 60}, ${x} ${y1 + 10}`
        : `M ${x} ${y1} C ${x + 46} ${y1}, ${x + 46} ${y2}, ${x} ${y2}`;
    } else {
      const forward = to.x > from.x;
      const x1 = from.x + (forward ? nodeWidth : 0), x2 = to.x + (forward ? 0 : nodeWidth);
      const y1 = from.y + nodeHeight / 2, y2 = to.y + nodeHeight / 2, mid = (x1 + x2) / 2;
      path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
    }
    return `<g data-relationship-id="${esc(edge.id)}" class="relationship ${esc(edge.kind)}"><title>${esc(json(edge))}</title><path d="${path}"/><text class="arrow-tip" x="${to.x + (to.x > from.x ? -9 : nodeWidth + 2)}" y="${to.y + nodeHeight / 2 + 5}">${to.x > from.x ? '›' : '‹'}</text></g>`;
  }).join('');
  const renderedNodes = nodes.map(node => {
    const p = positions.get(node.id);
    return `<g data-node-id="${esc(node.id)}" class="node ${esc(node.kind)}"><title>${esc(json(node))}</title><rect x="${p.x}" y="${p.y}" width="${nodeWidth}" height="${nodeHeight}" rx="7"/><text x="${p.x + 12}" y="${p.y + 23}">${esc(clipped(node.label))}</text><text class="node-kind" x="${p.x + 12}" y="${p.y + 43}">${esc(node.kind)}${node.state ? ` · ${esc(clipped(node.state, 24))}` : ''}</text></g>`;
  }).join('');
  return `<div class="drawing"><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="survey-drawing-title survey-drawing-desc" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title id="survey-drawing-title">API relationship survey</title><desc id="survey-drawing-desc">Static diagram of ${nodes.length} nodes and ${edges.length} relationships. Complete labels and supporting records follow below. All relationships retain their own evidence; endpoint execution does not prove an application caller.</desc>${columns.map(([kind, x]) => `<text class="column-heading" x="${x}" y="32">${esc(kind)}</text>`).join('')}${boxes}${arrows}${renderedNodes}</svg></div>`;
}

const record = value => `<pre>${esc(json(value))}</pre>`;
const list = values => values.length ? values.map(value => record(value)).join('') : '<p class="muted">None retained.</p>';

const SURVEY_CSS = `
.survey-report{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#111827;color:#e5e7eb;margin:0 auto;max-width:1500px;padding:32px;isolation:isolate}
.survey-report *{box-sizing:border-box}.survey-report h1{font-size:28px;margin:0 0 12px}.survey-report h2{font-size:20px;margin-top:32px}.survey-report h4{font-size:14px;margin-bottom:6px}.survey-report p{margin:8px 0}.survey-report code,.survey-report pre{font:13px/1.5 ui-monospace,monospace}.survey-report pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;background:#0b1220;border-radius:6px}
.survey-report .muted,.survey-report .basis{color:#aeb9c9}.survey-report .basis{max-width:1000px;overflow-wrap:anywhere}.survey-report .counts{display:flex;gap:20px;flex-wrap:wrap;padding:12px 0}.survey-report .counts strong{color:#93c5fd}.survey-report nav{display:flex;gap:20px;flex-wrap:wrap;margin:20px 0}.survey-report a{color:#93c5fd}.survey-report details{border:1px solid #334155;border-radius:8px;margin:10px 0;padding:10px 14px}.survey-report summary{cursor:pointer;overflow-wrap:anywhere}.survey-report summary .muted{font-size:13px;margin-left:8px}.survey-report .stack>summary{font-weight:600}.survey-report .record{background:#172033}.survey-report .kind{color:#7dd3fc;font-family:ui-monospace,monospace}.survey-report section{scroll-margin-top:20px}
.survey-report .drawing{overflow:auto;max-height:560px;border:1px solid #334155;border-radius:8px;background:#0b1220}.survey-report svg{display:block;font:13px system-ui,sans-serif}.survey-report svg text{fill:#e5e7eb}.survey-report .column-heading{text-transform:uppercase;font-size:12px;letter-spacing:1px;fill:#aeb9c9}.survey-report .stack-box rect{fill:#162137;stroke:#41516b}.survey-report .stack-box text{font-size:12px;fill:#cbd5e1}.survey-report .node rect{fill:#1e293b;stroke:#64748b}.survey-report .node.operation rect{stroke:#38bdf8}.survey-report .node-kind{font-size:11px;fill:#aeb9c9}.survey-report .relationship path{fill:none;stroke:#8798ad;stroke-width:1.5}.survey-report .relationship.supplies path{stroke:#c4b5fd}.survey-report .relationship.defines path{stroke:#86efac}.survey-report .arrow-tip{fill:#cbd5e1;font-size:22px}.survey-report .legend{font-size:13px}.survey-report .warning{border-left:3px solid #fbbf24;padding-left:12px}.survey-report .unlinked{overflow-wrap:anywhere}
@media(max-width:600px){.survey-report{padding:16px}.survey-report h1{font-size:24px}.survey-report details{padding:8px}}
`;

/** Shared offline projection for standalone reports and existing map consumers. */
export function renderSurveySection(snapshot, { status } = {}) {
  validateSurvey(snapshot);
  const nodes = ordered(snapshot.nodes), edges = ordered(snapshot.relationships);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const linked = new Set(edges.flatMap(edge => [edge.from, edge.to]));
  const nodeRecord = node => `<details class="record"><summary>${esc(node.label)} <span class="muted">${esc(node.kind)}${linked.has(node.id) ? '' : ' · unlinked'}</span></summary>${record(node)}</details>`;
  const operationGroups = groups(nodes).map(([stack, operations]) => `<details class="stack" open><summary>Stack ${esc(stack)} <span class="muted">${operations.length} operations</span></summary>${operations.map(nodeRecord).join('')}</details>`).join('');
  const others = nodes.filter(node => node.kind !== 'operation');
  const relationships = edges.map(edge => `<details class="record relationship-record"><summary><span class="kind">${esc(edge.kind)}</span> ${esc(byId.get(edge.from).label)} → ${esc(byId.get(edge.to).label)}</summary>
<p><code>${esc(edge.id)}</code></p><p>${esc(relationshipLabel(edge))}</p>
${edge.scope ? `<h4>Scope</h4>${record(edge.scope)}` : ''}
<h4>Declarations</h4>${list(edge.declarations)}<h4>Observations</h4>${list(edge.observations)}<h4>Operator attributions</h4>${list(edge.operator_attributions)}
<details><summary>Complete relationship record</summary>${record(edge)}</details></details>`).join('');
  return `<section class="survey-report" id="survey"><style>${SURVEY_CSS}</style>
<header><h1>API survey</h1>${heading(snapshot, status).map(line => `<p class="basis">${esc(line)}</p>`).join('')}
<p class="basis">This is a retained snapshot, not a live scan or a completeness claim. Missing caller evidence stays missing; an endpoint execution does not prove which file called it.</p>
<div class="counts"><span><strong>${nodes.length}</strong> nodes</span><span><strong>${edges.length}</strong> relationships</span><span><strong>${snapshot.unresolved.length}</strong> unresolved candidates</span></div></header>
<nav aria-label="Survey sections"><a href="#survey-diagram">Diagram</a><a href="#survey-operations">Stacks</a><a href="#survey-nodes">Other nodes</a><a href="#survey-relationships">Relationships</a><a href="#survey-coverage">Coverage &amp; limits</a></nav>
<section id="survey-diagram"><h2>Relationship diagram</h2><p class="legend">Defines: green · Calls: gray · Supplies: violet. Diagram labels may be shortened; records below retain complete metadata.</p>${drawing(nodes, edges)}</section>
<section id="survey-operations"><h2>Operations by stack</h2>${operationGroups || '<p>No operation nodes retained.</p>'}</section>
<section id="survey-nodes"><h2>Files, hosts and contracts</h2>${others.map(nodeRecord).join('') || '<p>No other nodes retained.</p>'}
<h3>Unlinked nodes</h3><p class="unlinked">${nodes.filter(node => !linked.has(node.id)).map(node => esc(node.label)).join(' · ') || 'None.'}</p></section>
<section id="survey-relationships"><h2>Relationships &amp; provenance</h2><p class="basis">Declarations, observations and operator attributions coexist. They do not promote an operation’s behavioral evidence class. A retained observation can have private proof unavailable in this checkout.</p>${relationships || '<p>No supported relationships retained.</p>'}</section>
<section id="survey-coverage"><h2>Coverage &amp; limits</h2><p class="warning">Zero unresolved candidates does not mean every API was found. The scanner cannot enumerate everything it does not recognize.</p>
<details open><summary>Coverage</summary>${record(snapshot.coverage)}</details><details><summary>Unresolved candidates</summary>${record(snapshot.unresolved)}</details><details><summary>Source identity</summary>${record(snapshot.source)}</details><details><summary>Scanner identity</summary>${record(snapshot.scanner)}</details></section>
<footer><p class="basis">Offline report. No scripts, network resources or checkout discovery. Generate or check the survey explicitly to obtain newer information.</p></footer>
</section>`;
}

/** One self-contained offline page; all interaction is native disclosure. */
export function renderSurveyHtml(snapshot, { status } = {}) {
  const content = renderSurveySection(snapshot, { status });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>API survey · ${esc(snapshot.snapshot.id)}</title><style>html{background:#111827}body{margin:0}</style></head><body>${content}</body></html>\n`;
}
