// Inspection is useful only when the declaration reaches the agent's existing
// context and request path. These readers never spawn or execute an MCP tool.
import { CONTEXT_FILE } from './context.mjs';
import { createHash } from 'node:crypto';
import { mcpServerKey } from './mcp-history.mjs';
import { safeMcpValue, schemaFacts, redactMcpUri } from './mcp-facts.mjs';
import { secretIn, redactMetadataSecrets } from './verdicts.mjs';
import { compactNoteRecord } from './note-projection.mjs';

// Request delivery keeps raw note strings for existing clients and attaches
// only the current review, never the review ledger. Labels remain paired with
// the delivered notes even when the envelope compacts other metadata.
export function reviewedNoteDelivery(record, scope = 'operation') {
  const projected = compactNoteRecord(record, { text: false });
  projected.review = { state: record.review?.state ?? 'unreviewed', label: record.review?.label ?? 'unreviewed' };
  return redactMetadataSecrets({ ...projected, scope, evidence_class: { class: record.evidence_class?.class ?? 'written' },
    contradictions: record.contradictions ?? [] });
}

export const MAX_INLINE_MCP_TOOLS = 15;
export const MAX_INLINE_MCP_SERVERS = 100;
export const MAX_INLINE_MCP_FIELDS = 10;
const MAX_INLINE_MCP_DIFFS = 6;
const HINTS = [['readOnlyHint', 'read-only'], ['destructiveHint', 'destructive'],
  ['idempotentHint', 'idempotent'], ['openWorldHint', 'open-world']];

export function latestMcpRecords(ctx) {
  const records = new Map();
  for (const record of ctx?.mcp_inspections ?? []) {
    const key = mcpServerKey(record);
    if (!key) continue; // Legacy records without any label cannot name a server.
    const previous = records.get(key);
    if (!previous || !(Date.parse(previous.at) > Date.parse(record.at))) records.set(key, record);
  }
  return [...records.values()];
}

const claimsFor = tool => Object.fromEntries(HINTS.filter(([key]) => typeof tool.annotations?.[key] === 'boolean')
  .map(([key]) => [key, tool.annotations[key]]));
const requiredFor = tool => Array.isArray(tool.inputSchema?.required)
  ? tool.inputSchema.required.filter(name => typeof name === 'string') : [];
const toolsFor = record => Array.isArray(record.declared?.tools) ? record.declared.tools : [];
const canonical = value => JSON.stringify(value, (_, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

// Registration labels remain independent evidence histories. Only delivery
// coalesces complete, identified declarations; missing identity/list evidence
// cannot establish that two registrations expose the same server.
function deliveryGroups(records) {
  const groups = new Map();
  for (const record of records) {
    const { name, version } = record.server ?? {};
    const digest = /^[a-f0-9]{64}$/.test(record.tool_declarations_digest ?? '') ? `raw:${record.tool_declarations_digest}`
      : `facts:${createHash('sha256').update(canonical(toolsFor(record).map(canonical).sort())).digest('hex')}`;
    const identity = name == null || version == null || !Array.isArray(record.declared?.tools) || record.declared?.tools_error
      ? record : canonical([name, version, digest, record.declared?.tools?.state ?? 'declared']);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(record);
  }
  return [...groups.values()];
}

// Exact tool names, optionally qualified by the registration label. Ambiguity
// is surfaced rather than silently borrowing a different server's declaration.
export function inspectedToolFor(ctx, wanted) {
  if (typeof wanted !== 'string' || !wanted.trim()) return null;
  const target = wanted.replace(/^\//, '');
  const matches = latestMcpRecords(ctx).flatMap(record => toolsFor(record)
    .filter(tool => typeof tool.name === 'string' && (tool.name === target || `${mcpServerKey(record)}/${tool.name}` === target))
    .map(tool => ({ record, tool })));
  if (!matches.length) return null;
  if (deliveryGroups(matches.map(({ record }) => record)).length > 1) return safeMcpValue({ code: 'MCP_TOOL_AMBIGUOUS',
    tool: target, servers: matches.map(({ record }) => mcpServerKey(record)) });
  const { record, tool } = matches[0];
  const server = record.server ?? { name: null };
  return safeMcpValue({
    op: `MCP ${mcpServerKey(record)}/${tool.name}`, tool: tool.name,
    server, confidence: 'declared', inspected_at: record.at ?? null,
    ...(server.name == null ? { identity_gap: 'identity unavailable (server.name: null)' } : {}),
    hint_claims: claimsFor(tool),
    declaration: { name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      inputSchema: schemaFacts(tool.inputSchema),
      ...(tool.outputSchema !== undefined ? { outputSchema: schemaFacts(tool.outputSchema) } : {}),
      annotations: claimsFor(tool) },
    ...(record.diff ? { last_diff: record.diff } : {}),
  });
}

// The envelope pays its usual budget. Deliver the actionable fields first;
// full schemas and historical diffs remain in `show` and the committed record.
export function knownMcpTool(ctx, target) {
  try {
    const found = inspectedToolFor(ctx, target);
    if (!found || found.code) return null;
    const required = requiredFor(found.declaration);
    const { op, tool, confidence, inspected_at, identity_gap, hint_claims } = found;
    const server = { label: found.server.label, name: found.server.name, version: found.server.version ?? null };
    return { op, tool, server, confidence, inspected_at,
      ...(identity_gap ? { identity_gap } : {}), hint_claims,
      required_inputs: required.slice(0, MAX_INLINE_MCP_FIELDS),
      ...(required.length > MAX_INLINE_MCP_FIELDS
        ? { required_inputs_omitted: required.length - MAX_INLINE_MCP_FIELDS } : {}) };
  } catch { return null; } // Corrupt/secret-bearing enrichment cannot break a request.
}

function diffParts(diff, cell, code) {
  const parts = [];
  for (const kind of ['tools', 'resources', 'resourceTemplates', 'prompts']) {
    const changes = diff[kind] ?? {};
    const noun = { tools: 'tool', resources: 'resource', resourceTemplates: 'resource template', prompts: 'prompt' }[kind];
    for (const action of ['added', 'removed']) {
      const names = changes[action] ?? [];
      if (names.length) parts.push(`${names.length} ${noun}${names.length === 1 ? '' : 's'} ${action} (${names.slice(0, MAX_INLINE_MCP_DIFFS).map(code).join(', ')}${names.length > MAX_INLINE_MCP_DIFFS ? ', …' : ''})`);
    }
    for (const row of changes.changed ?? []) {
      for (const change of row.changes ?? []) {
        const match = /^input required field (added|removed): (.*)$/.exec(change);
        if (match) parts.push(`required inputs changed on ${code(row.name)} (${match[1]}: ${code(match[2])})`);
        else {
          const field = /^(input|output)( required)? field (added|removed|type changed): (.*)$/.exec(change);
          parts.push(`${noun} changed: ${code(row.name)} — ${field ? `${field[1]}${field[2] ?? ''} field ${field[3]}: ${code(field[4])}` : code(change)}`);
        }
      }
    }
    if (changes.declaration) parts.push(`${cell(kind)} declaration: ${cell(changes.declaration.previous)} → ${cell(changes.declaration.current)}`);
  }
  for (const change of diff.server ?? []) parts.push(`server: ${cell(change)}`);
  if (diff.tool_declarations) parts.push(cell(diff.tool_declarations));
  if (diff.capabilities) parts.push(cell(diff.capabilities));
  if (diff.instructions) parts.push(cell(diff.instructions));
  return parts;
}

export function renderInlineMcp(ctx, registrations, { containsMachineLocalPath = () => false } = {}) {
  const keys = new Set(registrations.map(registration => registration.key));
  const records = latestMcpRecords(ctx).filter(record => keys.has(mcpServerKey(record)));
  if (!records.length) return [];
  // Agent identifiers must remain literal. The pointer escapes cell separators
  // and line breaks; code-span delimiters protect markup without entity-encoding
  // the identifier. CI summaries have their own, stricter escaping discipline.
  const cell = value => {
    const raw = redactMcpUri(value ?? '—');
    if (secretIn(raw)) return '[withheld]';
    if (containsMachineLocalPath(raw)) return '[machine-local path omitted]';
    // Comment markup is made visible: this text lands inside the managed pointer
    // block, which HTML comments delimit (a declared tool name could close it).
    return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/<!--/g, '[!--').replace(/-->/g, '--]').slice(0, 200).replace(/\|/g, '\\|');
  };
  const code = value => {
    const text = cell(value);
    const delimiter = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1);
    const pad = /^[` ]|[` ]$/.test(text) ? ' ' : '';
    return `${delimiter}${pad}${text}${pad}${delimiter}`;
  };
  const lines = ['**MCP servers this repo registers**', '',
    'Inspected declarations; hints are server claims, not evidence of safety.', ''];
  let remaining = MAX_INLINE_MCP_TOOLS;
  const groups = deliveryGroups(records);
  for (const group of groups.slice(0, MAX_INLINE_MCP_SERVERS)) {
    const record = group[0];
    const server = record.server ?? { name: null };
    const identity = server.name == null ? 'identity unavailable (server.name: null)' : code(server.name);
    const labels = new Set(group.map(mcpServerKey));
    const hostNames = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', vscode: 'VS Code / Copilot' };
    const aliases = [...new Set(registrations.filter(row => labels.has(row.key)).map(row => `${code(row.key)}${row.host ? ` (${cell(hostNames[row.host] ?? row.host)})` : ''}`))];
    lines.push(`Server: ${identity}${server.version != null ? ` ${code(server.version)}` : ''}`, `registered as: ${aliases.join(', ')}`, '');
    const tools = toolsFor(record);
    const inline = tools.slice(0, remaining);
    remaining -= inline.length;
    lines.push('| Tool | Hints (server claims) | Required inputs |', '| --- | --- | --- |');
    for (const tool of inline) {
      const claims = HINTS.map(([key, label]) => tool.annotations?.[key] === true ? `claims ${label}`
        : tool.annotations?.[key] === false ? `claims not ${label}` : `no ${label} claim`).join('; ');
      const required = requiredFor(tool);
      const fields = required.slice(0, MAX_INLINE_MCP_FIELDS).map(code).join(', ') || '—';
      lines.push(`| ${code(tool.name)} | ${claims} | ${fields}${required.length > MAX_INLINE_MCP_FIELDS ? `; ${required.length - MAX_INLINE_MCP_FIELDS} more required inputs omitted` : ''} |`);
    }
    if (!tools.length) lines.push('| — | — | — |');
    if (tools.length > inline.length) lines.push(`${tools.length - inline.length} more tool${tools.length - inline.length === 1 ? '' : 's'} in \`${CONTEXT_FILE}\`.`);
    const gaps = new Set();
    for (const member of group) for (const [key, title] of [['tools', 'Tool'], ['resources', 'Resource'], ['resourceTemplates', 'Resource template'], ['prompts', 'Prompt']]) {
      const error = member.declared?.[`${key}_error`];
      if (error) gaps.add(`${title} declaration coverage gap: ${code(error.code ?? 'MCP_LIST_FAILED')} — ${code(error.message ?? `${key}/list failed`)}.`);
    }
    lines.push(...gaps);
    const changedRecord = group.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .find(row => row.diff && diffParts(row.diff, cell, code).length);
    if (changedRecord) {
      const parts = diffParts(changedRecord.diff, cell, code);
      lines.push(`Last diff since ${cell(changedRecord.diff.since ?? changedRecord.diff_from)}: ${parts.slice(0, MAX_INLINE_MCP_DIFFS).join('; ')}${parts.length > MAX_INLINE_MCP_DIFFS ? `; ${parts.length - MAX_INLINE_MCP_DIFFS} more changes omitted` : ''}.`);
    }
    lines.push('');
  }
  if (groups.length > MAX_INLINE_MCP_SERVERS) lines.push(`${groups.length - MAX_INLINE_MCP_SERVERS} more registered servers in \`${CONTEXT_FILE}\`.`, '');
  return lines;
}
