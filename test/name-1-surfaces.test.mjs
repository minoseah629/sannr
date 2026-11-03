// NAME-1 acceptance (f), (h), (i), and the brand boundary behind (j).
// All requests are to a witness in a separate asynchronously spawned process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as brand from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { LIBRARIAN_MCP_SERVER_KEY } from '../lib/librarian.mjs';
import { setupGuidance } from '../lib/onboarding.mjs';
import { stagePackage } from '../scripts/stage-package.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const execute = promisify(execFile);
const LEGACY_KEY = 'api-request';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'name-1-surfaces-'));
  const home = join(dir, 'home'); mkdirSync(home);
  const repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const env = { PATH: process.env.PATH, HOME: home, [brand.HOME_ENV_NAME]: join(home, '.sannr'),
    API_USAGE_LOG: '', API_FRICTION_OFF: '1' };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, repo, home, env };
}

async function cli(repo, env, args) {
  try {
    const out = await execute(process.execPath, [CLI, ...args], { cwd: repo, env,
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, ...out };
  } catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}

async function connected(t) {
  const f = fixture(t);
  mkdirSync(dirname(join(f.repo, LAYOUT.environments)), { recursive: true });
  writeFileSync(join(f.repo, LAYOUT.environments), JSON.stringify({ v: 1, default: 'fixture',
    environments: { fixture: { baseUrl: 'https://api.example.test' } } }));
  const result = await cli(f.repo, f.env, ['connect', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return f;
}

test('NAME-1 server key follows the product while the measured tool and legacy skill remain pinned', async () => {
  assert.equal(brand.MCP_SERVER_KEY, brand.PRODUCT);
  assert.deepEqual(brand.LEGACY_MCP_SERVER_KEYS, [LEGACY_KEY]);
  assert.deepEqual(brand.LEGACY_SKILL_NAMES.request, [LEGACY_KEY]);
  assert.equal(brand.TOOL_NAME, 'api_request');
  // NAME-1 changes the ordinary registration; the separate restricted
  // experimental boundary retains its existing identity (2026-10-06).
  assert.equal(LIBRARIAN_MCP_SERVER_KEY, 'api-request-read-only');
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
    `const b = await import(${JSON.stringify(new URL('../lib/brand.mjs', import.meta.url).href)}); console.log(JSON.stringify({ key: b.MCP_SERVER_KEY, legacy: b.LEGACY_MCP_SERVER_KEYS, skill: b.LEGACY_SKILL_NAMES.request, tool: b.TOOL_NAME }));`],
    { env: { PATH: process.env.PATH, API_CONTEXT_PRODUCT_NAME: 'fixturebrand' } });
  assert.deepEqual(JSON.parse(stdout), { key: 'fixturebrand', legacy: [LEGACY_KEY],
    skill: [LEGACY_KEY], tool: 'api_request' });
});

test('NAME-1 (f) actual packed manifest exposes only sannr and its request subcommand reaches the child witness', async t => {
  const f = fixture(t);
  const staged = stagePackage(ROOT, join(f.dir, 'source'));
  await execute('npm', ['pack', '--offline', '--ignore-scripts', '--pack-destination', f.dir],
    { cwd: staged, timeout: 120_000 });
  const archive = join(f.dir, readdirSync(f.dir).find(name => name.endsWith('.tgz')));
  const unpacked = join(f.dir, 'unpacked'); mkdirSync(unpacked);
  await execute('tar', ['-xzf', archive, '-C', unpacked]);
  const pkg = join(unpacked, 'package');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { sannr: './bin/cli.mjs' });

  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => {
      process.stdout.write(JSON.stringify({ request: req.method + ' ' + req.url }) + '\\n');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n'));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let wire = '', errors = '';
  child.stdout.on('data', bytes => { wire += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child listener timed out: ' + errors)), 10_000);
    const listen = bytes => {
      for (const line of wire.split('\n').slice(0, -1)) {
        try { const value = JSON.parse(line); if (value.port) { clearTimeout(timer); child.stdout.off('data', listen); resolve(value.port); } }
        catch { /* a chunk may end within a JSON line */ }
      }
    };
    child.stdout.on('data', listen);
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const bin = join(f.repo, 'node_modules/.bin'); mkdirSync(bin, { recursive: true });
  const command = join(bin, 'sannr'); symlinkSync(join(pkg, manifest.bin.sannr), command);
  chmodSync(join(pkg, manifest.bin.sannr), 0o755);
  const out = await execute(command, ['request', 'GET', '/x', '--expect-status', '200'],
    { cwd: f.repo, env: { ...f.env, PATH: bin + ':' + f.env.PATH,
      API_BASE_URL: `http://127.0.0.1:${port}`, API_CONTEXT_OFF: '1', API_EVIDENCE: join(f.dir, 'evidence') }, timeout: 20_000 });
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 200); assert.equal(result.assertions.failed, 0);
  assert.match(result.evidence, /^run-/);
  assert.deepEqual(wire.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.request),
    [{ request: 'GET /x' }]);
});

test('NAME-1 (h) doctor names the actually registered current key', async t => {
  const f = await connected(t);
  const json = JSON.parse(readFileSync(join(f.repo, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(json.mcpServers), ['sannr']);
  const out = await cli(f.repo, f.env, ['doctor', '--offline', '--json']);
  const row = JSON.parse(out.stdout).checks.find(check => check.name === 'mcp');
  assert.equal(row.state, 'PASS', JSON.stringify(row));
  assert.match(row.detail, /as ['`]?sannr['`]?/);
});

test('NAME-1 (h) doctor warns about the actual legacy key and an executable legacy command without running it', async t => {
  const f = await connected(t);
  const registration = join(f.repo, '.mcp.json');
  const data = JSON.parse(readFileSync(registration, 'utf8'));
  data.mcpServers[LEGACY_KEY] = data.mcpServers[brand.MCP_SERVER_KEY];
  if (brand.MCP_SERVER_KEY !== LEGACY_KEY) delete data.mcpServers[brand.MCP_SERVER_KEY];
  writeFileSync(registration, JSON.stringify(data, null, 2) + '\n');
  const codex = join(f.repo, '.codex/config.toml');
  writeFileSync(codex, readFileSync(codex, 'utf8')
    .replaceAll(`${brand.MCP_SERVER_KEY}:managed-mcp`, `${LEGACY_KEY}:managed-mcp`)
    .replaceAll(`mcp_servers.${brand.MCP_SERVER_KEY}`, `mcp_servers.${LEGACY_KEY}`));
  const bin = join(f.dir, 'bin'); mkdirSync(bin);
  const marker = join(f.dir, 'legacy-command-executed');
  writeFileSync(join(bin, LEGACY_KEY), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, { mode: 0o755 });
  const out = await cli(f.repo, { ...f.env, PATH: bin + ':' + f.env.PATH }, ['doctor', '--offline', '--json']);
  const preview = JSON.parse((await cli(f.repo, f.env, ['connect', '--dry-run', '--json'])).stdout);
  assert.equal(preview.setup.host.server, LEGACY_KEY, 'a planned rename is not an activated server');
  const checks = JSON.parse(out.stdout).checks;
  const mcp = checks.find(row => row.name === 'mcp');
  assert.match(mcp.detail, /as ['`]?api-request['`]?/, JSON.stringify(mcp));
  assert.doesNotMatch(mcp.detail, /as ['`]?sannr['`]?/);
  const legacy = checks.filter(row => /api-request/.test(row.detail ?? '') && /legacy/i.test(row.detail ?? ''));
  assert.ok(legacy.some(row => row.state === 'WARN' && row.name !== 'path-binaries'), JSON.stringify(checks));
  const path = checks.find(row => row.name === 'path-binaries');
  assert.equal(path.state, 'WARN', JSON.stringify(path)); assert.match(path.detail, /api-request/);
  assert.equal(existsSync(marker), false, 'doctor must inspect metadata without executing the legacy launcher');
});

test('NAME-1 (g) doctor names untouched legacy leftovers only once', async t => {
  const f = fixture(t), old = join(f.home, '.agent-api-poc'); mkdirSync(old);
  const text = 'synthetic leftover contents must stay local';
  writeFileSync(join(old, 'keep.txt'), text, { mode: 0o600 });
  const first = JSON.parse((await cli(f.repo, f.env, ['doctor', '--offline', '--json'])).stdout);
  const notice = first.checks.find(row => row.name === 'legacy-state');
  assert.equal(notice?.state, 'WARN', JSON.stringify(notice));
  assert.match(notice.detail, /keep\.txt/); assert.doesNotMatch(JSON.stringify(first), /synthetic leftover contents/);
  assert.equal(readFileSync(join(old, 'keep.txt'), 'utf8'), text);
  const second = JSON.parse((await cli(f.repo, f.env, ['doctor', '--offline', '--json'])).stdout);
  // Corrected R11 (2026-10-06): source locations remain visible on every run;
  // only the leftover-name notice is suppressed after its first display.
  const again = second.checks.filter(row => row.name === 'legacy-state');
  assert.equal(again.length, 1); assert.equal(again[0].state, 'PASS');
  assert.match(again[0].detail, /Usage read sources:.*Readable token caches/);
  assert.doesNotMatch(JSON.stringify(again), /keep\.txt|synthetic leftover contents|Files left untouched/);
  assert.equal(readFileSync(join(old, 'keep.txt'), 'utf8'), text);
});

test('NAME-1 (i) installed instructions use the tool verb and active docs recommend no legacy server or command', async t => {
  const f = await connected(t);
  const pointer = readFileSync(join(f.repo, 'AGENTS.md'), 'utf8');
  assert.match(pointer, /check whether this task can access the repository-bound `api_request` tool\./);
  assert.doesNotMatch(pointer, /`api-request`/);
  for (const [role, name] of Object.entries(brand.SKILL_NAMES)) {
    const copy = readFileSync(join(f.repo, '.agents/skills', name, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(copy, /`api-request`/, `${role} skill recommends a legacy server or command`);
  }
  for (const path of ['README.md', 'docs/mcp.md', 'docs/agent-guide.md', 'docs/agent-examples.md', 'docs/install-prompt.md']) {
    const prose = readFileSync(join(ROOT, path), 'utf8');
    const active = prose.split('\n').filter(line => !/legacy|migrat|historical|previous|formerly|renam|earlier/i.test(line)).join('\n');
    const bad = active.split("\n").find(line => /(?:mcp inspect --only api-request|server announces `api-request`|(?:use|through|choose|call)[^\n.]{0,100}`api-request`|api-request --report)/i.test(line));
    assert.equal(bad, undefined, `${path} recommends the legacy MCP key or package command: ${bad}`);
  }
});

test('NAME-1 actual-key guidance never invents a server for an unregistered repository', () => {
  assert.doesNotMatch(setupGuidance(), /Registered server:/);
  assert.doesNotMatch(setupGuidance(null, null, undefined), /Registered server:/);
  assert.match(setupGuidance(null, null, LEGACY_KEY), /Registered server: `api-request`/);
  assert.match(setupGuidance(null, null, brand.MCP_SERVER_KEY), /Registered server: `sannr`/);
});
