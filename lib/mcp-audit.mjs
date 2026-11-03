// CI witnesses declarations against the committed inspection, never a newer
// working copy. Enumeration is the only effect: this path has no execution or
// storage option, including when a server claims its tools are read-only.
import { execFileSync } from 'node:child_process';
import { CONTEXT_FILE } from './context.mjs';
import { discoverMcpRegistrations } from './mcp-registrations.mjs';
import { inspectMcp } from './mcp-inspect.mjs';
import { diffMcpInspection, mcpServerKey } from './mcp-history.mjs';
import { isObject, safeMcpValue } from './mcp-facts.mjs';

export const MAX_MCP_BASELINE_BYTES = 8 * 1024 * 1024;
const baselineName = `HEAD:${CONTEXT_FILE}`;
const safe = value => {
  try { return safeMcpValue(value); }
  catch { return '[withheld]'; }
};

function committedRecords(root) {
  let raw;
  try {
    // ./ is significant: git resolves it from the project cwd, also for a
    // nested project in a larger checkout. No working-tree fallback is allowed.
    raw = execFileSync('git', ['show', `HEAD:./${CONTEXT_FILE}`], {
      cwd: root, encoding: 'utf8', maxBuffer: MAX_MCP_BASELINE_BYTES,
      timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { records: [], code: error.code === 'ENOBUFS' ? 'MCP_BASELINE_LIMIT' : 'MCP_RECORD_NOT_COMMITTED',
      reason: error.code === 'ENOBUFS' ? 'committed inspection store exceeds the 8 MiB read bound' : `no readable ${CONTEXT_FILE} at HEAD for this project` };
  }
  try {
    const context = JSON.parse(raw);
    if (!isObject(context) || context.mcp_inspections !== undefined && !Array.isArray(context.mcp_inspections)) throw new Error('invalid inspection collection');
    return { records: context.mcp_inspections ?? [] };
  } catch {
    return { records: [], code: 'MCP_BASELINE_INVALID', reason: `committed ${CONTEXT_FILE} does not contain a readable inspection collection` };
  }
}

export async function auditMcpDeclarations(root, { registrations = discoverMcpRegistrations(root) } = {}) {
  const witness = { baseline: baselineName, registered: registrations.length, checked: 0, drift: [], coverage_gaps: [] };
  if (!registrations.length) return witness;
  const committed = committedRecords(root);
  const latest = new Map();
  for (const record of committed.records) {
    if (!isObject(record)) continue;
    const key = mcpServerKey(record);
    if (key && (!latest.has(key) || (Date.parse(record.at) || 0) >= (Date.parse(latest.get(key).at) || 0))) latest.set(key, record);
  }
  for (const registration of registrations) {
    const identity = { server: safe(registration.key), host: safe(registration.host), file: safe(registration.file) };
    const gap = (code, reason) => witness.coverage_gaps.push({ ...identity, code: safe(code), reason: safe(reason) });
    const previous = latest.get(registration.key);
    if (!previous) { gap(committed.code ?? 'MCP_RECORD_NOT_COMMITTED', committed.reason ?? 'no committed inspection for this registration key'); continue; }
    if (registration.code) { gap(registration.code, registration.reason); continue; }
    let current, diff;
    try {
      // Deliberate field selection keeps any future execution options out.
      current = await inspectMcp({ command: registration.command, args: registration.args,
        env: registration.env, cwd: registration.cwd ?? root, label: registration.key });
      diff = diffMcpInspection(safeMcpValue(previous), current);
    } catch (error) {
      const code = /^MCP_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'MCP_INSPECTION_UNAVAILABLE';
      gap(code, code === 'MCP_LITERAL_SECRET_REFUSED' ? 'declarations withheld by the secret scanner'
        : 'server could not be spawned or enumerated; declarations were not compared');
      continue;
    }
    if (diff.tools?.unavailable?.length) {
      gap('MCP_TOOLS_COMPARISON_UNAVAILABLE', diff.tools.unavailable.join('; '));
      continue;
    }
    witness.checked++;
    const row = (kind, name, changes) => {
      witness.drift.push({ key: `mcp | ${identity.host} | ${identity.server} | ${kind} | ${name}`,
        severity: 'medium', service: identity.server, op: name, kind,
        detail: changes.join('; '), where: `${identity.file}: ${identity.server}`, ...identity });
    };
    for (const name of diff.tools?.added ?? []) row('mcp-tool-added', name, ['tool declaration added']);
    for (const name of diff.tools?.removed ?? []) row('mcp-tool-removed', name, ['tool declaration removed']);
    for (const change of diff.tools?.changed ?? []) row('mcp-tool-changed', change.name, change.changes);
  }
  return witness;
}
