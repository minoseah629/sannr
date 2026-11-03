import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_CLASSES, MCP_HTTP_CLASSES, HTTP_CLASSES, startFixture, TIMEOUT_MS, timeoutFor, MARKER } from './network-fixture.mjs';
import { isDefect, table, summary } from './driver.mjs';
export { table, summary };
const repo = fileURLToPath(new URL('../../', import.meta.url));
export function jobs(iterations = 1) {
  return ['inspectMcp:stdio', 'inspectMcp:http', 'apiRequest'].flatMap(entry => (entry.endsWith('stdio') ? MCP_CLASSES : entry.endsWith('http') ? MCP_HTTP_CLASSES : HTTP_CLASSES).flatMap(variation => Array.from({ length: iterations }, (_, index) => ({ entry, variation, index }))));
}
export const cleanEnv = (root, url, variation) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:API_|SANNR_|FLEET_|POSTMAN_|NODE_OPTIONS)/.test(key))), HOME: root, USERPROFILE: root, API_CONTEXT_DIR: root, API_CONTEXT_OFF: '1', API_FRICTION_OFF: '1', API_USAGE_LOG: join(root, 'usage.jsonl'), API_EVIDENCE: join(root, 'evidence'), API_BASE_URL: url ?? 'http://127.0.0.1:1', API_TIMEOUT_MS: String(timeoutFor(variation)), API_BUDGET: '800' });
async function child(args, root, env, deadline = 4000) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timeout = false;
    const timer = setTimeout(() => { timeout = true; proc.kill('SIGKILL'); }, deadline);
    proc.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 256 * 1024) proc.kill('SIGKILL'); });
    proc.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 256 * 1024) proc.kill('SIGKILL'); });
    proc.on('error', () => {});
    proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code, timeout }); });
  });
}
export async function runJob(job) {
  const root = mkdtempSync(join(tmpdir(), 'network-robustness-'));
  let fixture;
  try {
    if (!job.entry.endsWith('stdio')) fixture = await startFixture(job.entry === 'apiRequest' || job.entry.includes('request') ? 'http' : 'mcp', job.variation, job.index);
    const env = cleanEnv(root, fixture?.url, job.variation);
    if (job.variation.startsWith('oauth-')) Object.assign(env, { API_AUTH: 'oauth:FIXTURE_CLIENT_ID:FIXTURE_CLIENT_SECRET', FIXTURE_CLIENT_ID: 'fixture-client', FIXTURE_CLIENT_SECRET: 'fixture-private', API_OAUTH_TOKEN_URL: fixture.url });
    if (job.entry === 'cli:mcp-registered:stdio') writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [join(repo, 'test/robustness/network-fixture.mjs'), job.variation] } } }));
    const cli = job.entry.startsWith('cli:');
    let args;
    switch (job.entry) {
      case 'cli:mcp-registered:stdio': args = [join(repo, 'bin/cli.mjs'), 'mcp', 'inspect', '--json']; break;
      case 'cli:request-envelope': args = [join(repo, 'bin/request.mjs'), 'envelope', JSON.stringify({ v: 2, requests: [{ method: 'GET', path: '/' }] })]; break;
      case 'cli:request-direct': args = [join(repo, 'bin/request.mjs'), 'GET', '/']; break;
      case 'cli:request': args = [join(repo, 'bin/cli.mjs'), 'request', 'GET', '/']; break;
      case 'cli:mcp:stdio': case 'cli:mcp:http':
        args = [join(repo, 'bin/cli.mjs'), 'mcp', 'inspect', ...(fixture ? [fixture.url] : [process.execPath, join(repo, 'test/robustness/network-fixture.mjs'), job.variation]), '--json']; break;
      default: args = [join(repo, 'test/robustness/network-probe.mjs'), JSON.stringify({ ...job, url: fixture?.url })];
    }
    const childResult = await child(args, root, env, cli && job.entry.includes('mcp') ? 12000 : timeoutFor(job.variation) + 3250);
    if (cli) {
      const text = childResult.stdout + childResult.stderr;
      const codes = text.match(/\b(?:MCP|RESPONSE|REQUEST|TRANSPORT)_[A-Z_]+\b/g) ?? [];
      return { ...job, outcome: childResult.timeout ? 'timeout' : 'result', exitCode: childResult.code, codes, ms: 0, rssDelta: 0, leaks: text.includes(MARKER) ? ['diagnostic'] : [], violations: /\n\s+at |(?:Type|Range|Syntax)Error:/.test(text) ? ['stack'] : [], source: 'network-fixture', index: job.index ?? 0 };
    }
    let output;
    try { output = JSON.parse(childResult.stdout); } catch { output = { outcome: childResult.timeout ? 'timeout' : 'worker-error', violations: [], ms: 4000, rssDelta: 0, leaks: [] }; }
    if (output.code !== expectedCode(job)) output.violations.push('unexpected-outcome');
    return { ...job, ...output, source: 'network-fixture', seed: 1 };
  } finally { if (fixture) await fixture.close(); rmSync(root, { recursive: true, force: true }); }
}
// A named refusal alone is insufficient: valid controls must still succeed,
// and each malformed class must hit the intended boundary, not an earlier one.
export function expectedCode({ entry, variation }) {
  if (entry === 'apiRequest') {
    if (['oversized-body', 'binary-oversized', 'gzip-expansion', 'deep-json', 'oauth-oversized', 'page-oversized', 'page-deep'].includes(variation)) return 'RESPONSE_OVERSIZED';
    if (['chunked-never', 'slow-body', 'retry-slow', 'retry-delay', 'redirect-slow', 'oauth-slow', 'page-slow'].includes(variation)) return 'REQUEST_TIMEOUT';
    if (['invalid-length', 'lying-length', 'header-flood'].includes(variation)) return 'TRANSPORT_FAILED';
    if (variation === 'invalid-redirect') return 'RESPONSE_REDIRECT_INVALID';
    if (variation === 'redirect-loop') return 'RESPONSE_REDIRECT_LOOP';
    if (variation === 'oauth-null') return 'OAUTH_NO_ACCESS_TOKEN';
    return null;
  }
  if (['oversized-frame', 'deep-schema'].includes(variation)) return 'MCP_OVERSIZED';
  if (variation === 'non-utf8') return 'MCP_ENCODING_INVALID';
  if (variation === 'session-change') return 'MCP_SESSION_CHANGED';
  if (['ten-thousand-tools', 'list-spread'].includes(variation)) return 'MCP_LIST_LIMIT';
  if (variation === 'rpc-error') return 'MCP_LIST_FAILED';
  if (['redirect', 'status-503'].includes(variation)) return 'MCP_HTTP_FAILED';
  if (variation === 'exit-mid-frame') return 'MCP_SERVER_EXITED';
  if (['trickle', 'sse-never', 'slow-pages'].includes(variation)) return 'MCP_TIMEOUT';
  if (['wrong-id', 'malformed-json'].includes(variation)) return entry.endsWith('stdio') ? 'MCP_TIMEOUT' : 'MCP_NO_RESPONSE';
  return null;
}
export const defective = row => isDefect(row) || row.violations.length > 0;
export async function runNetwork(iterations = 1) {
  const output = [];
  // Three lanes, fixed order within each lane. Fixtures and env are per call.
  await Promise.all(['inspectMcp:stdio', 'inspectMcp:http', 'apiRequest'].map(async entry => {
    for (const job of jobs(iterations).filter(job => job.entry === entry)) output.push(await runJob(job));
  }));
  return output.sort((a, b) => a.entry.localeCompare(b.entry) || a.variation.localeCompare(b.variation) || a.index - b.index);
}
