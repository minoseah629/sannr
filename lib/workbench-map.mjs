// The browser's dependency map is a projection of an explicitly saved survey.
// Reading it never generates/checks a survey, scans source, or makes a request.
// The separate endpoint coverage view uses the existing Workbench snapshot.
import { readSurvey, SURVEY_FILE } from './survey.mjs';
import { surveyStatusSummary } from './survey-model.mjs';
import { CLI_NAME } from './brand.mjs';

export const WORKBENCH_MAP_BYTES = 96 * 1024;
const NODE_LIMIT = 160, EDGE_LIMIT = 240, SUPPORT_LIMIT = 3;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const support = row => pick(row, ['kind', 'file', 'line', 'environment', 'record_id', 'author', 'at', 'proof']);
function node(value) {
  return { ...pick(value, ['id', 'kind', 'label', 'stack', 'operation', 'file', 'host', 'contract', 'state']),
    references: (value.references ?? []).slice(0, SUPPORT_LIMIT), references_omitted: Math.max(0, (value.references?.length ?? 0) - SUPPORT_LIMIT) };
}
function relationship(value) {
  const groups = ['declarations', 'observations', 'operator_attributions'];
  return { ...pick(value, ['id', 'kind', 'from', 'to', 'source_field', 'target_parameter', 'scope']),
    support_counts: Object.fromEntries(groups.map(key => [key, value[key].length])),
    support_omitted: Object.fromEntries(groups.map(key => [key, Math.max(0, value[key].length - SUPPORT_LIMIT)])),
    ...Object.fromEntries(groups.map(key => [key, value[key].slice(0, SUPPORT_LIMIT).map(support)])) };
}

export function buildWorkbenchMap(root) {
  const saved = readSurvey(root);
  const result = { state: saved.state, file: SURVEY_FILE,
    commands: { generate: `${CLI_NAME} survey generate`, status: `${CLI_NAME} survey status`,
      query: `${CLI_NAME} survey query --max-bytes 65536` },
    nodes: [], relationships: [] };
  if (saved.state !== 'ready') {
    if (saved.diagnostic) result.diagnostic = saved.diagnostic;
    return result;
  }
  const snapshot = saved.snapshot;
  Object.assign(result, { snapshot: snapshot.snapshot, current_inputs: surveyStatusSummary(saved.status, snapshot.snapshot.id),
    basis: 'Retained structural snapshot. Reading does not scan code or contact an API. An endpoint response does not prove its caller.',
    totals: { nodes: snapshot.nodes.length, relationships: snapshot.relationships.length, unresolved: snapshot.unresolved.length },
    omitted: { nodes: snapshot.nodes.length, relationships: snapshot.relationships.length, unresolved: snapshot.unresolved.length },
    coverage: pick(snapshot.coverage, ['eligible_files', 'scanned_files', 'skipped_files', 'unreadable_files', 'oversized_files', 'truncated']),
    limitations: [], limitations_omitted: snapshot.coverage.limitations.length,
    unresolved: [], limits: { max_bytes: WORKBENCH_MAP_BYTES, nodes: NODE_LIMIT, relationships: EDGE_LIMIT } });
  const nodes = new Map(snapshot.nodes.map(value => [value.id, value])), included = new Set();
  const fits = () => Buffer.byteLength(JSON.stringify(result)) <= WORKBENCH_MAP_BYTES;
  // Record-count caps alone do not bound strings or nested metadata. Reserve
  // three quarters of the total budget for the graph; diagnostics retain exact
  // omission counts without truncating a reason into a different claim.
  const metadataFits = () => Buffer.byteLength(JSON.stringify(result)) <= WORKBENCH_MAP_BYTES / 4;
  for (const limitation of snapshot.coverage.limitations.slice(0, 4)) {
    result.limitations.push(limitation); result.limitations_omitted--;
    if (!metadataFits()) { result.limitations.pop(); result.limitations_omitted++; break; }
  }
  for (const unresolved of snapshot.unresolved.slice(0, 12)) {
    result.unresolved.push(unresolved); result.omitted.unresolved--;
    if (!metadataFits()) { result.unresolved.pop(); result.omitted.unresolved++; break; }
  }
  // Reserve complete endpoint pairs before adding unlinked nodes. An edge is
  // never drawn to an omitted node. First-fit uses canonical artifact ordering.
  for (const edge of snapshot.relationships) {
    if (result.relationships.length >= EDGE_LIMIT || result.nodes.length >= NODE_LIMIT) break;
    const additions = [...new Set([edge.from, edge.to])].filter(id => !included.has(id)).map(id => node(nodes.get(id)));
    if (result.nodes.length + additions.length > NODE_LIMIT) break;
    result.nodes.push(...additions); result.relationships.push(relationship(edge));
    if (!fits()) { result.nodes.splice(result.nodes.length - additions.length, additions.length); result.relationships.pop(); break; }
    for (const item of additions) included.add(item.id);
  }
  for (const value of snapshot.nodes) {
    if (result.nodes.length >= NODE_LIMIT) break;
    if (included.has(value.id)) continue;
    result.nodes.push(node(value));
    if (!fits()) { result.nodes.pop(); break; }
    included.add(value.id);
  }
  result.omitted.nodes = snapshot.nodes.length - result.nodes.length;
  result.omitted.relationships = snapshot.relationships.length - result.relationships.length;
  return result;
}
