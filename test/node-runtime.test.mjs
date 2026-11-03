import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { stableNodeCommand } from '../lib/node-runtime.mjs';
import { MCP_SERVER_KEY, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { setupBindingId } from '../lib/setup-binding.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin/cli.mjs');
const fresh = t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-upgrade-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const run = (cwd, env, ...args) => new Promise(resolveRun => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => resolveRun({ code, stdout, stderr }));
});

test('a Homebrew upgrade can remove the old keg and the saved command still launches Node', t => {
  const dir = fresh(t);
  const old = join(dir, 'Cellar/node/22.0.0/bin/node');
  const next = join(dir, 'Cellar/node/22.1.0/bin/node');
  const alias = join(dir, 'opt/node/bin/node');
  for (const path of [old, next, alias]) mkdirSync(dirname(path), { recursive: true });
  // Distinct executable files make this a real change in executable identity.
  for (const path of [old, next]) writeFileSync(path,
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  symlinkSync(old, alias);
  const saved = stableNodeCommand({ execPath: old, path: '/usr/bin:/bin' });
  assert.equal(saved, alias);
  rmSync(alias); symlinkSync(next, alias);
  rmSync(join(dir, 'Cellar/node/22.0.0'), { recursive: true });
  const response = execFileSync(saved, [join(root, 'server.mjs')], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', API_USAGE_LOG: '' }, encoding: 'utf8',
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'upgrade-test', version: '1' } } }) + '\n',
  });
  assert.ok(JSON.parse(response.trim()).result.serverInfo);
});

test('Node selection retains a versioned formula, rejects foreign aliases, and never pins an unaliased keg', t => {
  const dir = fresh(t), old = join(dir, 'Cellar/node@22/22.0.0/bin/node');
  const alias = join(dir, 'opt/node@22/bin/node');
  for (const path of [old, alias]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(old, '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  symlinkSync(old, alias);
  assert.equal(stableNodeCommand({ execPath: old, path: '/usr/bin:/bin' }), alias);
  rmSync(alias); symlinkSync(process.execPath, alias);
  assert.equal(stableNodeCommand({ execPath: old, path: '/usr/bin:/bin' }), 'node');
});

test('offline doctor sends zero API requests and repairs dead generated runtimes without changing neighbors', async t => {
  const dir = fresh(t), home = fresh(t);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const env = { ...process.env, HOME: home, [HOME_ENV_NAME]: home, API_USAGE_LOG: '' };
  for (const key of ['API_CONFIG', 'API_CONTEXT_DIR', 'API_CONTRACT', 'API_ENV', 'API_BASE_URL', 'API_AUTH', 'API_EVIDENCE']) delete env[key];
  let calls = 0;
  const server = createServer((req, res) => { calls++; res.end('unexpected'); });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const configPath = join(dir, LAYOUT.environments);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ v: 1, default: 'local', environments: {
    local: { baseUrl: `http://127.0.0.1:${server.address().port}` },
  } }));
  // An existing Claude instruction file receives the same managed block as
  // AGENTS.md, so both binding-marker repairs must preserve their neighbors.
  writeFileSync(join(dir, 'CLAUDE.md'), 'Existing Claude guidance.\n');
  const connected = await run(dir, env, 'connect', '--json');
  assert.equal(connected.code, 0, connected.stderr + connected.stdout);
  const jsonPath = join(dir, '.mcp.json'), tomlPath = join(dir, '.codex/config.toml');
  const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const expected = structuredClone(doc.mcpServers[MCP_SERVER_KEY]);
  const missing = join(dir, 'Cellar/node/old/bin/node');
  doc.mcpServers[MCP_SERVER_KEY].command = missing;
  const oldBinding = setupBindingId(dir, doc.mcpServers[MCP_SERVER_KEY]);
  doc.mcpServers[MCP_SERVER_KEY].env.API_SETUP_BINDING = oldBinding;
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(dir, file);
    writeFileSync(path, 'User instructions stay here.\n' + readFileSync(path, 'utf8')
      .replaceAll(expected.env.API_SETUP_BINDING, oldBinding));
  }
  doc.mcpServers.neighbor = { command: '/not/ours', args: ['keep'], env: { FLAG: 'yes' } };
  writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(tomlPath, readFileSync(tomlPath, 'utf8').replace(
    `command = ${JSON.stringify(expected.command)}`, `command = ${JSON.stringify(missing)}`)
    .replaceAll(expected.env.API_SETUP_BINDING, oldBinding));
  const broken = await run(dir, env, 'doctor', '--offline', '--json');
  assert.equal(JSON.parse(broken.stdout).checks.find(c => c.name === 'mcp').state, 'FAIL');
  const fixed = await run(dir, env, 'doctor', '--offline', '--repair', '--json');
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  const report = JSON.parse(fixed.stdout);
  assert.equal(report.checks.find(c => c.name === 'mcp').state, 'PASS');
  assert.match(report.checks.find(c => c.name === 'mcp-repair').detail, /Restart or reload/);
  assert.equal(calls, 0);
  assert.equal(report.request_target, undefined);
  const after = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(after.mcpServers[MCP_SERVER_KEY], expected);
  assert.deepEqual(after.mcpServers.neighbor, doc.mcpServers.neighbor);
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const guidance = readFileSync(join(dir, file), 'utf8');
    assert.ok(guidance.startsWith('User instructions stay here.\n'));
    assert.ok(guidance.includes(`Setup binding: ${expected.env.API_SETUP_BINDING}`));
    assert.ok(!guidance.includes(oldBinding));
  }
  const repairedBytes = readFileSync(jsonPath, 'utf8');
  await run(dir, env, 'doctor', '--offline', '--repair', '--json');
  assert.equal(readFileSync(jsonPath, 'utf8'), repairedBytes);
  // Edited API settings must not get silently replaced by a runtime repair.
  after.mcpServers[MCP_SERVER_KEY].command = missing;
  after.mcpServers[MCP_SERVER_KEY].env.API_BASE_URL = 'http://user-choice.invalid';
  const editedBytes = JSON.stringify(after, null, 2) + '\n';
  writeFileSync(jsonPath, editedBytes);
  const refused = await run(dir, env, 'doctor', '--offline', '--repair', '--json');
  assert.equal(JSON.parse(refused.stdout).checks.find(c => c.name === 'mcp-repair').state, 'FAIL');
  assert.equal(readFileSync(jsonPath, 'utf8'), editedBytes);
  assert.equal(calls, 0);
});
