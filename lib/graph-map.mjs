// A supplemental view of the shared catalog. The source-scan model and its
// counts remain untouched; this section renders declarations, never requests.
import { createHash } from 'node:crypto';

const escape = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const array = value => Array.isArray(value) ? value : [];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const anchor = value => `shared-node-${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
function repositoryUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\x00-\x20\x7f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

const styles = `<style>
#shared-dependency-graph{margin:36px 0 24px;padding:clamp(18px,3vw,32px);border:1px solid var(--lime,#c8f224);box-shadow:9px 9px 0 rgba(200,242,36,.22);color:var(--paper,#efeee9);background:var(--bg,#0b0b0b);scroll-margin-top:20px}
#shared-dependency-graph .sg-eyebrow{color:var(--lime,#c8f224);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
#shared-dependency-graph .sg-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
#shared-dependency-graph h2{font-family:Impact,"Arial Narrow",sans-serif;font-weight:400;font-size:clamp(30px,4vw,48px);line-height:1;text-transform:uppercase;margin:8px 0 14px}
#shared-dependency-graph h3{font-family:Impact,"Arial Narrow",sans-serif;font-weight:400;font-size:23px;text-transform:uppercase;margin:24px 0 10px}
#shared-dependency-graph .sg-label{padding:3px 8px;border:1px solid var(--muted,#85847c);color:var(--soft,#b8b7b0);font-size:10px;letter-spacing:.1em;text-transform:uppercase}
#shared-dependency-graph p{font-size:12px;line-height:1.7;margin:8px 0;color:var(--soft,#b8b7b0)}
#shared-dependency-graph .sg-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:22px 0}
#shared-dependency-graph .sg-stat{padding:14px;border:1px solid var(--line,rgba(239,238,233,.22));overflow-wrap:anywhere}
#shared-dependency-graph .sg-stat strong{display:block;font-family:Impact,"Arial Narrow",sans-serif;font-weight:400;color:var(--lime,#c8f224);font-size:40px;line-height:1}
#shared-dependency-graph .sg-stat span{display:block;margin-top:10px;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
#shared-dependency-graph .sg-list{list-style:none;padding:0;border:1px solid var(--line,rgba(239,238,233,.22))}
#shared-dependency-graph .sg-list>li{padding:13px 15px;border-bottom:1px solid var(--line,rgba(239,238,233,.22));overflow-wrap:anywhere}
#shared-dependency-graph .sg-list>li:last-child{border-bottom:0}
#shared-dependency-graph .sg-wire{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;font-size:14px}
#shared-dependency-graph .sg-arrow{color:var(--lime,#c8f224);font-weight:bold}
#shared-dependency-graph .sg-detail{display:block;font-size:11px;color:var(--soft,#b8b7b0);margin-top:6px;overflow-wrap:anywhere}
#shared-dependency-graph a{color:var(--paper,#efeee9);text-decoration:underline;text-decoration-color:var(--lime,#c8f224);text-underline-offset:3px}
#shared-dependency-graph a:hover{color:var(--lime,#c8f224)}
#shared-dependency-graph a:focus-visible{outline:2px solid var(--lime,#c8f224);outline-offset:4px}
#shared-dependency-graph .sg-empty{padding:14px;border:1px dashed var(--muted,#85847c)}
#shared-dependency-graph .sg-unresolved{border-left:3px solid var(--red,#ff4a3d)}
#shared-dependency-graph .sg-node:target{outline:2px solid var(--lime,#c8f224);outline-offset:3px;scroll-margin-top:20px}
#shared-dependency-graph details{margin-top:20px;border-top:1px solid var(--line,rgba(239,238,233,.22));padding-top:14px}
#shared-dependency-graph summary{cursor:pointer;color:var(--lime,#c8f224);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
@media(max-width:560px){#shared-dependency-graph .sg-stats{grid-template-columns:1fr}#shared-dependency-graph .sg-stat{display:flex;align-items:center;gap:16px}#shared-dependency-graph .sg-stat span{margin:0}}
</style>`;

export function decorateGraphMapHtml(html, graph) {
  if (typeof html !== 'string' || !graph || !/<\/main\s*>/iu.test(html) || html.includes('id="shared-dependency-graph"')) return html;
  const repositories = array(graph.repositories), nodes = array(graph.nodes), edges = array(graph.edges), unresolved = array(graph.unresolved);
  const byNode = new Map(nodes.filter(node => node && typeof node.id === 'string').map(node => [node.id, node]));
  const byRepo = new Map(repositories.filter(repo => repo && typeof repo.id === 'string').map(repo => [repo.id, repo]));
  const repoLink = id => {
    const repo = byRepo.get(id), name = escape(repo?.name ?? id), url = repositoryUrl(repo?.url);
    return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${name} <span aria-hidden="true">↗</span></a>` : name;
  };
  const nodeLink = id => {
    const node = byNode.get(id);
    return node ? `<a href="#${anchor(id)}">${escape(node.name ?? id)}</a>` : `<span>${escape(id)}</span>`;
  };
  const empty = message => `<p class="sg-empty">${escape(message)}</p>`;
  const list = items => `<ul class="sg-list">${items.join('')}</ul>`;
  const stats = [
    [repositories.length, 'Repository snapshots shown'], [edges.length, 'Declared relationships shown'],
    [count(graph.callers?.count), 'Known caller repos · lower bound'],
  ].map(([number, label]) => `<div class="sg-stat"><strong>${number}</strong><span>${label}</span></div>`).join('');
  const wires = edges.filter(edge => edge && typeof edge === 'object').map(edge => `<li><div class="sg-wire">${nodeLink(edge.from)}<span class="sg-arrow" aria-label="depends on">→</span>${nodeLink(edge.to)}<span class="sg-label">${escape(edge.kind ?? 'declared dependency')}</span></div>`
    + `<span class="sg-detail">Declared by ${repoLink(edge.repository)}${edge.file ? ` · ${escape(edge.file)}` : ''}</span>`
    + ([edge.protocol, edge.environment].filter(Boolean).length ? `<span class="sg-detail">${[edge.protocol, edge.environment].filter(Boolean).map(escape).join(' · ')}</span>` : '')
    + (array(edge.operations).length ? `<span class="sg-detail">Operations: ${array(edge.operations).map(escape).join(', ')}</span>` : '') + '</li>');
  const repoRows = repositories.filter(repo => repo && typeof repo === 'object').map(repo => `<li>${repoLink(repo.id)}<span class="sg-detail">${escape(repo.id)}${repo.generated_at ? ` · snapshot exported ${escape(repo.generated_at)}` : ''}${repositoryUrl(repo.url) ? '' : ' · repository link not published'}</span></li>`);
  const nodeRows = nodes.filter(node => node && typeof node === 'object').map(node => `<li class="sg-node${node.unresolved ? ' sg-unresolved' : ''}" id="${anchor(node.id)}"><strong>${escape(node.name ?? node.id)}</strong><span class="sg-detail">${escape(node.id)} · ${escape(node.kind ?? 'node')}${node.file ? ` · ${escape(node.file)}` : ''}</span></li>`);
  const unresolvedRows = unresolved.filter(item => item && typeof item === 'object').map(item => `<li class="sg-unresolved"><strong>${escape(item.id)}</strong><span class="sg-detail">The selected snapshots do not define this provider node or its repository location. Other publishers may still have saved claims about it.</span></li>`);
  const reports = [
    ...array(graph.issues).map(issue => typeof issue === 'string' ? issue : [issue?.code, issue?.message].filter(Boolean).join(': ')),
    ...array(graph.omissions).map(item => typeof item === 'string' ? item : [item?.repository, item?.message].filter(Boolean).join(': ')),
  ].filter(Boolean);
  const limited = Object.values(graph.truncated ?? {}).some(Boolean) || Object.values(graph.omitted_response_items ?? {}).some(value => count(value) > 0);
  const coverage = `<p>Coverage is partial. These are published dependency declarations; they do not establish live traffic or a breaking change.</p>`
    + `<p>The local source-scan counts above are unchanged. Shared declarations are shown separately.</p>`
    + (limited ? '<p class="sg-empty">This is a bounded view; additional declarations or metadata were omitted.</p>' : '')
    + `<p>${count(graph.callers?.count) ? 'Known callers are a lower bound. Other callers may be missing from the selected snapshots.' : 'No callers are declared in the selected snapshots. Other callers are unknown.'}</p>`
    + (array(graph.callers?.repositories).length ? `<p>Known caller repositories: ${array(graph.callers.repositories).map(repoLink).join(', ')}.</p>` : '');
  const body = graph.ok === false
    ? empty('Shared graph context is unavailable for this map. The local source scan remains separate.')
    : `<div class="sg-stats">${stats}</div>${coverage}<h3>Follow the wires.</h3>${wires.length ? list(wires) : empty('No dependency declarations are available in this view.')}`
      + `<h3>Find the repository.</h3>${repoRows.length ? list(repoRows) : empty('No repository snapshots are available in this view.')}`
      + (nodeRows.length ? `<h3>Declared nodes</h3>${list(nodeRows)}` : '')
      + `<h3>Open ends.</h3>${unresolvedRows.length ? list(unresolvedRows) : empty('No unresolved provider nodes are shown in this partial view.')}`
      + `<p>Agents receive a small dependency index first and retrieve saved API context for the operation they are working on. This overview does not expand the saved knowledge store.</p>`;
  const details = reports.length ? `<details><summary>Coverage &amp; provenance · ${reports.length} report${reports.length === 1 ? '' : 's'}</summary>`
    + list(reports.slice(0, 30).map(report => `<li>${escape(report)}</li>`))
    + (reports.length > 30 ? `<p>${reports.length - 30} further coverage reports are omitted from this page.</p>` : '') + '</details>' : '';
  const section = `${styles}<section id="shared-dependency-graph" aria-labelledby="shared-graph-title"><span class="sg-eyebrow">// shared dependency graph</span><div class="sg-heading"><h2 id="shared-graph-title">The next repo.</h2><span class="sg-label">Partial coverage · declared</span></div>${body}${details}</section>`;
  return html.replace(/<\/main\s*>/iu, match => `${section}\n${match}`);
}
