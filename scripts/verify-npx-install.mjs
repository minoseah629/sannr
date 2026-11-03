// Cold npm-exec installation against an exact local tarball. A loopback registry
// stands in for unpublished distribution; this is not a live desktop-host test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME_ENV_NAME, MCP_SERVER_KEY, NPM_PACKAGE, PRODUCT, TOOL_NAME, CONTEXT_BASENAME, FEEDBACK_STACK_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';

const exec = promisify(execFile);
const [archiveArg, outputArg] = process.argv.slice(2);
if (!archiveArg || !outputArg || process.argv.length !== 4) {
  console.error('Usage: node scripts/verify-npx-install.mjs <exact-package.tgz> <receipt.json>');
  process.exit(2);
}
const archive = resolve(archiveArg), output = resolve(outputArg);
const bytes = readFileSync(archive);
const pkg = JSON.parse(execFileSync('tar', ['xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
assert.equal(pkg.name, NPM_PACKAGE);
const scratch = mkdtempSync(join(tmpdir(), `${PRODUCT}-npx-cold-`));
const home = join(scratch, 'home'), repo = join(scratch, 'repo with spaces');
const cache = join(scratch, 'empty-npm-cache');
mkdirSync(home); mkdirSync(repo); mkdirSync(join(repo, '.cursor'));
writeFileSync(join(home, '.npmrc'), '');
writeFileSync(join(repo, 'AGENTS.md'), 'Preserve this existing project guidance.\n');
writeFileSync(join(repo, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Installation fixture', version: '1' },
  paths: { '/health': { get: { responses: { '200': { description: 'Fixture only' } } } } } }));
const requests = [];
let address;
const registry = createServer((req, res) => {
  requests.push({ method: req.method, path: req.url });
  assert.equal(req.method, 'GET', 'The fixture registry is read-only');
  res.setHeader('content-type', 'application/json');
  if (decodeURIComponent(req.url).split('?')[0] === `/${pkg.name}`) {
    const version = { ...pkg, dist: { tarball: `${address}/package.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } };
    res.end(JSON.stringify({ name: pkg.name, 'dist-tags': { alpha: pkg.version }, versions: { [pkg.version]: version } }));
  } else if (req.url === '/package.tgz') {
    res.setHeader('content-type', 'application/octet-stream'); res.end(bytes);
  } else {
    res.statusCode = 404; res.end(JSON.stringify({ error: 'Only the exact core package is served by this fixture' }));
  }
});
await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
address = `http://127.0.0.1:${registry.address().port}`;
// Exercise ordinary doctor through the installed client. A harness-only fetch
// boundary maps the exact default GitHub URL to a controlled loopback fixture;
// this is explicitly not evidence of GitHub availability or a public install.
const probeRequests = [];
const probeServer = createServer((req, res) => {
  probeRequests.push({ method: req.method, path: req.url });
  res.setHeader('content-type', req.url === '/zen' ? 'text/plain' : 'application/json');
  res.setHeader('x-ratelimit-limit', '60');
  res.setHeader('x-ratelimit-remaining', '59');
  res.setHeader('x-ratelimit-used', '1');
  res.setHeader('x-ratelimit-reset', '1900000000');
  res.setHeader('x-ratelimit-resource', 'core');
  res.end(req.url === '/zen' ? 'Controlled onboarding fixture.' : JSON.stringify({ fixture: 'doctor-install-check' }));
});
await new Promise(resolve => probeServer.listen(0, '127.0.0.1', resolve));
const probeOrigin = `http://127.0.0.1:${probeServer.address().port}`;
const probeUrl = `${probeOrigin}/health`;
const announcementProof = join(scratch, 'announcement-proof.jsonl');
const guard = join(scratch, 'default-probe-fixture.mjs');
writeFileSync(guard, String.raw`
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
const original = globalThis.fetch;
let announced = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    return write(chunk, typeof encoding === 'string' ? encoding : undefined, error => {
      if (!error && String(chunk).startsWith('About to request: ')) announced.push(String(chunk));
      done?.(error);
    });
  };
}
globalThis.fetch = (input, options) => {
  const url = String(input);
  const isDefault = url === 'https://api.github.com/zen';
  const isFixture = url.startsWith(${JSON.stringify(probeOrigin)} + '/');
  assert.ok(isDefault || isFixture, 'Unexpected fetch in cold-install fixture');
  assert.ok(announced.length, 'Request executed before the announcement completed');
  const announcement = announced.shift();
  assert.ok(announcement.includes(url), 'Announcement did not name the original request');
  appendFileSync(${JSON.stringify(announcementProof)}, JSON.stringify({url,method:options?.method,announcement_completed:true,default_target_simulated:isDefault}) + '\n');
  if (isDefault) {
    assert.equal(options?.method, 'GET');
    return original(${JSON.stringify(probeOrigin)} + '/zen', options);
  }
  return original(input, options);
};
`);
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, CI: '1', NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
  [HOME_ENV_NAME]: join(home, 'state'), npm_config_cache: cache, npm_config_userconfig: join(home, '.npmrc'),
  npm_config_registry: address, npm_config_ignore_scripts: 'true', npm_config_omit: 'optional',
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
const steps = [];
const receipt = { schema_version: 1, captured_at: new Date().toISOString(), platform: process.platform,
  architecture: process.arch, node: process.version, package: pkg.name, version: pkg.version,
  tarball_sha256: createHash('sha256').update(bytes).digest('hex'),
  scope: 'Exact local tarball, clean HOME/npm cache, loopback npm registry, optional libraries omitted. Default doctor uses a harness-only fetch mapping of GitHub Zen to a controlled loopback response; configured doctor uses loopback directly. Exact-version npx host config and real MCP process/protocol validation use a minimal host PATH plus only the generated registration environment; no desktop agent session.',
  api_requests_executed: 0, repository_api_requests_executed: 0, steps, hosts: [], state: 'failed' };
async function command(args, allowFailure = false, envOverrides = {}) {
  const started = performance.now(); let result;
  try { result = { ...(await exec('npx', ['--yes', `${NPM_PACKAGE}@alpha`, ...args], { cwd: repo, env: { ...env, ...envOverrides }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })), status: 0 }; }
  catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', status: error.code ?? 'spawn-failed' }; }
  steps.push({ command: ['npx', '--yes', `${NPM_PACKAGE}@alpha`, ...args], status: result.status,
    duration_ms: Math.round(performance.now() - started), stdout: result.stdout, stderr: result.stderr });
  if (!allowFailure) assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
function codexEntry(text) {
  const entry = { env: {} }; let mode = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) { mode = line.includes(`mcp_servers.${MCP_SERVER_KEY}.env]`) ? 'env'
      : line === `[mcp_servers.${MCP_SERVER_KEY}]` ? 'server' : ''; continue; }
    const match = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line);
    if (!match || !mode) continue;
    if (mode === 'server' && match[1] === 'env') entry.env = JSON.parse(match[2].replace(/("(?:[^"\\]|\\.)*")\s*=/g, '$1:'));
    else if (mode === 'env') entry.env[match[1]] = JSON.parse(match[2]);
    else if (['command', 'args'].includes(match[1])) entry[match[1]] = JSON.parse(match[2]);
  }
  assert.equal(typeof entry.command, 'string'); assert.ok(Array.isArray(entry.args)); return entry;
}
async function inventory(entry) {
  assert.equal(basename(entry.command), 'npx', 'npm installs must register the npx launcher');
  assert.deepEqual(entry.args, ['--yes', '--ignore-scripts', `--package=${pkg.name}@${pkg.version}`, '--', PRODUCT, 'mcp', 'serve'],
    'The registered package must be the exact installed version, with no cache path or floating tag');
  assert.ok(!entry.command.includes(`${cache}/`), 'The launcher must not point inside the npm cache');
  const child = spawn(entry.command, entry.args, { cwd: home, env: { ...env, PATH: '/usr/bin:/bin', ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    return await new Promise((resolve, reject) => {
      let buffer = '', stderr = '';
      const timeout = setTimeout(() => done(new Error(`MCP protocol timed out: ${stderr}`)), 30_000);
      function done(error, result) { clearTimeout(timeout); error ? reject(error) : resolve(result); }
      child.on('error', error => done(error));
      child.on('exit', code => done(new Error(`MCP exited ${code}: ${stderr}`)));
      child.stderr.on('data', data => { stderr += data; });
      child.stdout.on('data', data => {
        buffer += data;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          try {
            const reply = JSON.parse(line);
            if (reply.id === 1) {
              assert.ok(reply.result?.serverInfo);
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
            } else if (reply.id === 2) {
              const tool = reply.result?.tools?.find(row => row.name === TOOL_NAME);
              assert.ok(tool, 'API tool is present');
              assert.ok(tool.description.includes(`Setup binding: ${entry.env.API_SETUP_BINDING}`), 'Loaded binding matches saved registration');
              done(null, { tools: reply.result.tools.map(row => row.name), binding: entry.env.API_SETUP_BINDING });
            }
          } catch (error) { done(error); }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cold-install-fixture', version: '1' } } }) + '\n');
    });
  } finally { child.kill(); }
}
try {
  const started = performance.now();
  const connect = JSON.parse((await command(['connect', '--json'])).stdout);
  assert.ok(connect.mcp.every(row => row.action !== 'conflict'), 'All requested host registrations are writable');
  assert.equal(connect.omitted.length, 0, 'Installed skills have portable runnable CLI guidance');
  assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /^Preserve this existing project guidance\./);
  assert.ok(readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes(`<!-- ${PRODUCT}:begin -->`), 'AGENTS.md holds the full managed guidance');
  assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n', 'A missing CLAUDE.md becomes only the shared-guidance bridge');
  receipt.setup = connect.setup;
  const catalog = JSON.parse((await command(['stacks', '--json'])).stdout);
  // The packaged feedback API is visible alongside repository-owned stacks;
  // its presence must not hide a missing or duplicated discovered contract.
  const builtin = catalog.stacks.filter(row => row.name === FEEDBACK_STACK_NAME);
  assert.equal(builtin.length, 1, 'The packaged feedback stack appears exactly once');
  assert.deepEqual(builtin[0].environments, ['public']);
  assert.equal(builtin[0].contract.state, 'bound');
  assert.equal(builtin[0].counts.operations, 2);
  const repoStacks = catalog.stacks.filter(row => row.name !== FEEDBACK_STACK_NAME);
  assert.equal(repoStacks.length, 1, 'Cold connect discovers the contract into one repository stack');
  assert.equal(repoStacks[0].counts.operations, 1);
  const stackName = repoStacks[0].name;
  const stackFolder = join(repo, LAYOUT.collection, stackName);
  const stackFile = join(stackFolder, 'stack.json');
  const doctorScope = report => {
    assert.equal(report.stacks?.length, 1, 'Ordinary doctor reports exactly the fixture stack');
    assert.equal(report.stacks[0].stack, stackName);
    return report.stacks[0];
  };
  const doctor = await command(['doctor', '--json']);
  receipt.doctor = doctorScope(JSON.parse(doctor.stdout));
  const freshBase = receipt.doctor.checks.find(row => row.name === 'base-url');
  assert.equal(freshBase?.state, 'PASS');
  assert.match(doctor.stderr, /About to request: GET https:\/\/api\.github\.com\/zen/);
  assert.deepEqual(probeRequests, [{ method: 'GET', path: '/zen' }]);
  receipt.default_probe_simulated = true;
  receipt.default_announced_requests = doctor.stderr;
  const firstProbe = receipt.doctor.api_probe;
  assert.equal(firstProbe.target_source, 'default');
  assert.equal(firstProbe.status, 200);
  assert.equal(firstProbe.http_ok, true);
  assert.ok(Number.isSafeInteger(firstProbe.duration_ms) && firstProbe.duration_ms >= 0);
  assert.equal(firstProbe.rate_limit_headers['x-ratelimit-limit'], '60');
  assert.equal(firstProbe.rate_limit_headers['x-ratelimit-remaining'], '59');
  assert.equal(firstProbe.observation.state, 'recorded');
  assert.equal(firstProbe.observation.evidence_id, firstProbe.evidence);
  const retrieved = await command(['context', 'query', '--onboarding']);
  receipt.first_observation = JSON.parse(retrieved.stdout);
  receipt.first_retrieval_ms = Math.round(performance.now() - started);
  assert.equal(receipt.first_observation.state, 'recorded');
  assert.equal(receipt.first_observation.first.evidence_id, firstProbe.evidence);
  assert.equal(receipt.first_observation.first.provider, 'https://api.github.com');
  assert.equal(receipt.first_observation.first.url, 'https://api.github.com/zen');
  assert.equal(receipt.first_observation.first.repo_contract, null);
  assert.equal(receipt.first_observation.first.assertions, 'not_run');
  assert.equal(probeRequests.length, 1, 'Reading the first observation must execute no request');
  receipt.first_observation_sha256 = createHash('sha256').update(readFileSync(join(repo, firstProbe.observation.path))).digest('hex');

  const fixtureNote = 'Cold-install fixture author claim; separate from the observed onboarding request.';
  await command(['note', 'GET /health', fixtureNote]);
  const shown = await command(['show', 'GET /health']);
  assert.ok(shown.stdout.includes(fixtureNote));
  receipt.author_note_retrieval_ms = Math.round(performance.now() - started);
  receipt.restart_required_for_cli = false;
  receipt.desktop_host_restart = 'Not exercised. A fresh host task must confirm the matching setup binding after MCP refresh/restart.';
  const knowledgeFile = join(stackFolder, CONTEXT_BASENAME);
  const knowledgeBeforeProbe = readFileSync(knowledgeFile);
  // Explicit stacks intentionally ignore shell API_BASE_URL. Configure the
  // synthetic stack itself, then refresh registration before its new process.
  const configuredStack = JSON.parse(readFileSync(stackFile, 'utf8'));
  configuredStack.default_environment = 'fixture';
  configuredStack.environments = { fixture: { baseUrl: probeUrl } };
  writeFileSync(stackFile, JSON.stringify(configuredStack, null, 2) + '\n');
  await command(['connect', '--json']);
  const configured = await command(['doctor', '--json']);
  receipt.configured_doctor = { ...doctorScope(JSON.parse(configured.stdout)), announced_requests: configured.stderr };
  assert.match(configured.stderr, /HEAD /, 'The configured probe must announce its read');
  assert.ok(configured.stderr.includes(probeUrl), 'Announcement identifies the fixture target');
  assert.deepEqual(probeRequests, [{ method: 'GET', path: '/zen' }, { method: 'HEAD', path: '/health' }]);
  assert.equal(receipt.configured_doctor.api_probe.authentication, 'not_sent');
  assert.equal(receipt.configured_doctor.api_probe.assertions, 'not_run');
  assert.ok(readFileSync(knowledgeFile).equals(knowledgeBeforeProbe), 'Reachability must not promote shared API knowledge');
  const evidenceId = receipt.configured_doctor.api_probe.evidence;
  assert.match(evidenceId, /^run-[A-Za-z0-9-]+$/);
  const probeEvidence = readFileSync(join(repo, LAYOUT.evidence, stackName, `${evidenceId}.json`));
  receipt.probe_evidence_sha256 = createHash('sha256').update(probeEvidence).digest('hex');
  const overridden = await command(['doctor', '--probe', `${probeOrigin}/alternate`, '--json']);
  receipt.override_doctor = { ...doctorScope(JSON.parse(overridden.stdout)), announced_requests: overridden.stderr };
  assert.match(overridden.stderr, /About to request: GET /);
  assert.ok(overridden.stderr.includes(`${probeOrigin}/alternate`));
  assert.deepEqual(probeRequests, [{ method: 'GET', path: '/zen' }, { method: 'HEAD', path: '/health' }, { method: 'GET', path: '/alternate' }]);
  assert.ok(readFileSync(knowledgeFile).equals(knowledgeBeforeProbe), 'Explicit onboarding probe must not promote shared API knowledge');
  const offline = await command(['doctor', '--offline', '--json']);
  receipt.offline_doctor = doctorScope(JSON.parse(offline.stdout));
  assert.equal(probeRequests.length, 3, 'Offline doctor must not execute another fixture request');
  receipt.announcement_proof = readFileSync(announcementProof, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(receipt.announcement_proof.length, 3);
  const latest = await command(['context', 'query', '--onboarding']);
  receipt.latest_observation = JSON.parse(latest.stdout);
  assert.equal(receipt.latest_observation.first.evidence_id, firstProbe.evidence, 'First observation survives later probes');
  assert.equal(receipt.latest_observation.latest.target_source, 'override');
  assert.equal(receipt.latest_observation.latest.evidence_id, receipt.override_doctor.api_probe.evidence);
  assert.equal(receipt.latest_observation.latest.url, `${probeOrigin}/alternate`);
  assert.equal(probeRequests.length, 3, 'Retrieval and offline checks execute no additional request');
  receipt.doctor_fixture_requests = probeRequests;
  const entries = [
    ['Claude Code', JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers[MCP_SERVER_KEY]],
    ['Codex', codexEntry(readFileSync(join(repo, '.codex/config.toml'), 'utf8'))],
    ['Cursor', JSON.parse(readFileSync(join(repo, '.cursor/mcp.json'), 'utf8')).mcpServers[MCP_SERVER_KEY]],
  ];
  for (const [host, entry] of entries) receipt.hosts.push({ host,
    scope: 'Generated exact-version npx config launched as an MCP process with host PATH=/usr/bin:/bin plus generated registration environment, from a different cwd',
    package: `${pkg.name}@${pkg.version}`, ...await inventory(entry), status: 'passed' });
  receipt.cache_lifetime = 'MCP registrations select the exact installed package version through npx, without retaining an npm cache server path. Node and npx remain launch prerequisites; a missing package may require a registry download. This check does not prune the cache or move a dist-tag.';
  receipt.registry_requests = requests;
  receipt.state = 'passed';
} catch (error) { receipt.error = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  receipt.api_requests_executed = probeRequests.length;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve));
  probeServer.closeAllConnections(); await new Promise(resolve => probeServer.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ state: receipt.state, receipt: output, node: receipt.node, hosts: receipt.hosts.length,
  first_retrieval_ms: receipt.first_retrieval_ms, tarball_sha256: receipt.tarball_sha256, error: receipt.error ?? null }, null, 2));
