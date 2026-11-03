import { LAYOUT } from './layout.mjs';
// Enumeration and recording are the default. An annotation is a server claim,
// never permission: every tools/call needs its own explicit opt-in.
import { basename, join } from 'node:path';
import { emptyContext, loadContextSnapshot, saveContext } from './context.mjs';
import { createMcpSession } from './mcp-transport.mjs';
import { isObject, mcpError, scanMcpValue, safeMcpValue, schemaFacts, validateToolArgs, guardCredentialArgs, observeTool } from './mcp-facts.mjs';
import { diffMcpInspection, mcpServerKey, mcpToolDeclarationsDigest, pruneMcpInspections } from './mcp-history.mjs';
export { pruneMcpInspections } from './mcp-history.mjs';

function toolFacts(tool) {
  return {
    name: tool.name,
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    inputSchema: schemaFacts(tool.inputSchema),
    ...(tool.outputSchema !== undefined ? { outputSchema: schemaFacts(tool.outputSchema) } : {}),
    annotations: Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].filter(k => typeof tool.annotations?.[k] === 'boolean').map(k => [k, tool.annotations[k]])),
  };
}
function pick(item, fields) {
  return Object.fromEntries(fields.filter(k => item[k] !== undefined).map(k => [k, item[k]]));
}
function declarationFacts(declared) {
  const map = (list, project) => Array.isArray(list) ? list.map(project) : list;
  return {
    ...declared,
    tools: map(declared.tools, toolFacts),
    resources: map(declared.resources, item => pick(item, ['name', 'description', 'uri', 'mimeType'])),
    resourceTemplates: map(declared.resourceTemplates, item => pick(item, ['name', 'description', 'uriTemplate', 'mimeType'])),
    prompts: map(declared.prompts, item => ({ ...pick(item, ['name', 'description']), arguments: (Array.isArray(item.arguments) ? item.arguments : []).filter(isObject).map(arg => pick(arg, ['name', 'description', 'required'])) })),
  };
}

export async function inspectMcp({ command, args = [], env, cwd, url, execute = [], executeUnsafe = false, toolArgs = {}, label, timeoutMs } = {}) {
  if (Boolean(command) === Boolean(url)) throw mcpError('provide exactly one MCP stdio command or URL', 'MCP_TARGET_INVALID');
  scanMcpValue([command, ...args, url, ...execute, label, toolArgs]);
  guardCredentialArgs(toolArgs);
  if (!isObject(toolArgs)) throw mcpError("MCP arguments invalid at '$': expected object", 'MCP_ARGS_INVALID');
  const session = createMcpSession({ command, args, env, cwd, url, timeoutMs, deadline: Date.now() + (timeoutMs ?? 10_000) });
  const transport = url ? 'streamable-http' : 'stdio';
  try {
    const response = await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'sannr-inspect', version: '0.1.0' } });
    if (response.error || !isObject(response.result)) throw mcpError('MCP server did not initialize', 'MCP_NOT_INITIALIZED');
    const initialize = response.result;
    await session.notify('notifications/initialized');
    const capabilityDeclared = key => isObject(initialize.capabilities) && Object.hasOwn(initialize.capabilities, key);
    const declared = Object.fromEntries(['tools', 'resources', 'resourceTemplates', 'prompts'].map(key => [key,
      capabilityDeclared(key === 'resourceTemplates' ? 'resources' : key) ? [] : { state: 'not_declared' },
    ]));
    async function list(method, field) {
      if (declared[field].state === 'not_declared') return;
      let cursor;
      const seen = new Set();
      for (let page = 0; page < 100; page++) {
        let reply;
        try { reply = await session.request(method, cursor === undefined ? {} : { cursor }); }
        catch (error) { declared[`${field}_error`] = { code: error.code ?? 'MCP_LIST_FAILED', message: error.message }; return; }
        if (reply.error) { declared[`${field}_error`] = { code: 'MCP_LIST_FAILED', message: 'MCP server rejected the list request' }; return; }
        if (!Array.isArray(reply.result?.[field]) || reply.result[field].some(x => !isObject(x))) {
          declared[`${field}_error`] = { code: 'MCP_LIST_INVALID', message: 'MCP list response has an invalid declaration array' }; return;
        }
        declared[field].push(...reply.result[field].slice(0, 101));
        if (declared[field].length > 100) {
          declared[field] = declared[field].slice(0, 100);
          declared[`${field}_error`] = { code: 'MCP_LIST_LIMIT', message: 'MCP list exceeds 100 declarations' }; return;
        }
        cursor = reply.result.nextCursor;
        if (cursor === undefined) return;
        if (typeof cursor !== 'string' || seen.has(cursor)) break;
        seen.add(cursor);
      }
      declared[`${field}_error`] = { code: 'MCP_LIST_LIMIT', message: 'MCP list pagination exceeded its bound or repeated a cursor' };
    }
    await list('tools/list', 'tools');
    await list('resources/list', 'resources');
    await list('resources/templates/list', 'resourceTemplates');
    await list('prompts/list', 'prompts');
    // Validate the entire opt-in batch before its first effect, using the full
    // declaration; the bounded promoted schema is not a validation contract.
    const calls = [...new Set(execute)].map(name => {
      const tool = Array.isArray(declared.tools) ? declared.tools.find(item => item.name === name) : null;
      if (!tool) throw mcpError(`tool '${safeMcpValue(name)}' was not declared by the server`, 'MCP_TOOL_NOT_DECLARED');
      if (tool.annotations?.readOnlyHint !== true && !executeUnsafe)
        throw mcpError(`tool '${safeMcpValue(name)}' is not claimed read-only; pass --execute-unsafe to opt in`, 'MCP_TOOL_NOT_READ_ONLY');
      const arguments_ = Object.hasOwn(toolArgs, name) ? toolArgs[name] : {};
      validateToolArgs(arguments_, tool.inputSchema);
      return { name, arguments_, tool };
    });
    const name = typeof initialize.serverInfo?.name === 'string' && initialize.serverInfo.name.trim() ? initialize.serverInfo.name : null;
    const server = name || label ? { name, version: initialize.serverInfo?.version ?? null, protocolVersion: initialize.protocolVersion ?? null, transport, label: label || name } : { name: null };
    // Sanitize declarations before any opted-in execution or human rendering.
    const tool_declarations_digest = Array.isArray(declared.tools) && !declared.tools_error ? mcpToolDeclarationsDigest(declared.tools) : undefined;
    const inspection = safeMcpValue({ server, capabilities: initialize.capabilities ?? {}, instructions: initialize.instructions ?? null, transport, initialized: true,
      ...(tool_declarations_digest ? { tool_declarations_digest } : {}), declared: declarationFacts(declared), measured: [] });
    for (const { name, arguments_, tool } of calls) {
      const reply = await session.request('tools/call', { name, arguments: arguments_ });
      inspection.measured.push({ tool: safeMcpValue(name), observed: observeTool(reply, tool.outputSchema) });
    }
    inspection.malformed_frames = session.malformed_frames;
    return inspection;
  } catch (error) {
    error.malformed_frames = session.malformed_frames;
    throw error;
  } finally { await session.close(); }
}

export function storeMcpInspection(root, inspection, { returnRecord = false } = {}) {
  const snapshot = loadContextSnapshot(root);
  const context = snapshot?.ctx ?? emptyContext({ name: basename(root), contractPath: null, contractDigest: null });
  // Preserve compatibility for callers of the original storage function while
  // dropping raw call results and arguments at this final promotion boundary.
  const projected = { ...inspection };
  delete projected.env; delete projected.cwd;
  scanMcpValue(projected);
  if (typeof projected.tool_declarations_digest !== 'string' || !/^[a-f0-9]{64}$/.test(projected.tool_declarations_digest)
    || !Array.isArray(projected.declared?.tools) || projected.declared.tools_error) delete projected.tool_declarations_digest;
  delete projected.command; delete projected.args; delete projected.url; delete projected.toolArgs;
  if (Array.isArray(projected.declared?.tools)) projected.declared = { ...projected.declared, tools: projected.declared.tools.map(toolFacts) };
  if (Array.isArray(projected.measured)) projected.measured = projected.measured.map(m => ({
    tool: m.tool,
    ...(m.observed ? { observed: { ...pick(m.observed, ['matches_output_schema', 'missing', 'unexpected', 'result_kind', 'type_mismatches', 'schema_limitations']), ...(Array.isArray(m.observed.fields) ? { fields: m.observed.fields.filter(isObject).map(field => pick(field, ['name', 'type'])) } : {}) } } : { status: m.status ?? null, resultShape: m.result == null ? null : Array.isArray(m.result) ? 'array' : typeof m.result }),
  }));
  const bounded = safeMcpValue(projected);
  bounded.server = bounded.server ?? { name: null };
  const history = context.mcp_inspections ?? [];
  const key = mcpServerKey(bounded);
  const previous = key ? history.findLast(record => mcpServerKey(record) === key) : null;
  // Millisecond timestamps are immutable identities, including back-to-back
  // writes within one process. Advance only the new record if needed.
  const last = Math.max(0, ...history.map(record => Date.parse(record.at) || 0));
  const record = { ...bounded, at: new Date(Math.max(Date.now(), last + 1)).toISOString(), diff_from: previous?.at ?? null, diff: diffMcpInspection(previous, bounded) };
  scanMcpValue(record);
  const next = structuredClone(context);
  next.mcp_inspections = pruneMcpInspections([...history, record]);
  saveContext(root, next, snapshot ? { expectedDigest: snapshot.digest } : {});
  return returnRecord ? record : join(root, LAYOUT.context);
}
