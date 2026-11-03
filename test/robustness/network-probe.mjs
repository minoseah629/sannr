// One isolated client invocation; only measurements/classes return to the driver.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectMcp, storeMcpInspection } from '../../lib/mcp-inspect.mjs';
import { CONTEXT_FILE } from '../../lib/context.mjs';
import { MARKER, timeoutFor } from './network-fixture.mjs';
const job = JSON.parse(process.argv[2]);
const before = process.memoryUsage().rss;
let peak = before;
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
const start = performance.now();
let outcome = 'result', code = null, diagnostics = '', result, violations = [];
try {
  if (job.entry === 'apiRequest') {
    const { apiRequest } = await import('../../lib/client.mjs');
    result = await apiRequest({ path: '/', paginate: job.variation.startsWith('page-') ? true : undefined });
    code = result.error?.code ?? null;
    if (JSON.stringify(result).length > 4 * 800) violations.push('envelope-budget');
    if (result.ok === false && !code && job.variation !== 'redirect-loop') violations.push('uncoded-result');
  } else {
    result = await inspectMcp({ ...(job.url ? { url: job.url } : { command: process.execPath, args: [new URL('./network-fixture.mjs', import.meta.url).pathname, job.variation, String(job.index)] }), timeoutMs: timeoutFor(job.variation) });
    code = result.declared?.tools_error?.code ?? null;
    storeMcpInspection(process.cwd(), result);
    const record = readFileSync(join(process.cwd(), CONTEXT_FILE), 'utf8');
    if (record.length > 128 * 1024) violations.push('record-budget');
    if (record.includes(MARKER) || record.includes('network-private-diagnostic') || /\\u00(?:00|1b|7f)/i.test(record)) violations.push('record-unscanned');
    if (job.variation === 'ten-thousand-tools' && (result.declared.tools.length !== 100 || code !== 'MCP_LIST_LIMIT')) violations.push('list-bound');
    if (job.variation === 'duplicate-id' && result.declared.tools[0]?.name !== 'read') violations.push('reply-identity');
  }
} catch (error) {
  code = error?.code;
  outcome = error?.constructor === Error && typeof code === 'string' ? `named:${code}` : error instanceof Error ? `native:${error.name}` : 'uncoded';
  diagnostics = String(error?.message ?? '');
  if (diagnostics.length > 500 || diagnostics.includes(MARKER)) violations.push('diagnostic-bytes');
}
clearInterval(sample); peak = Math.max(peak, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
const ms = performance.now() - start;
if (ms > timeoutFor(job.variation) + 650) violations.push('deadline');
if (peak - before > 160 * 1024 * 1024) violations.push('memory');
if (code !== null && typeof code !== 'string') violations.push('nonstring-code');
process.stdout.write(JSON.stringify({ outcome, code, ms, rssDelta: peak - before, violations, leaks: [], diagnosticLength: diagnostics.length }));
// Explicitly leave cleanup to the parent even when a defective client hangs.
process.exit(0);
