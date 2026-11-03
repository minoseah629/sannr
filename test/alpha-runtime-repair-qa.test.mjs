import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_KEY, POINTER_BEGIN, POINTER_END, HOME_ENV_NAME } from '../lib/brand.mjs';
import { setupBindingId } from '../lib/setup-binding.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const PATHS = ['.mcp.json', '.codex/config.toml', 'AGENTS.md', 'CLAUDE.md'];

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-runtime-qa-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const env = { ...process.env, [HOME_ENV_NAME]: join(root, 'home'), API_USAGE_LOG: '', NO_COLOR: '1' };
  for (const key of ['API_CONFIG', 'API_CONTEXT_DIR', 'API_CONTRACT', 'API_ENV', 'API_BASE_URL', 'API_AUTH', 'API_EVIDENCE']) delete env[key];
  const guard = join(root, 'deny-network.mjs');
  writeFileSync(guard, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module';
    const denied=()=>{throw new Error('UNEXPECTED_NETWORK');}; globalThis.fetch=denied;
    for(const module of [http,https,net,tls]) for(const name of ['request','get','connect','createConnection','createServer']) if(typeof module[name]==='function') module[name]=denied; syncBuiltinESMExports();`);
  env.NODE_OPTIONS = `--import=${guard}`;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  // Existing CLAUDE.md files receive a full block. These tests deliberately
  // corrupt that second block to retain the all-or-nothing repair boundary.
  writeFileSync(join(root, 'CLAUDE.md'), 'Team Claude instructions.\n');
  const connected = run('connect', '--json');
  assert.equal(connected.status, 0, connected.stdout + connected.stderr);
  const doc = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  const current = structuredClone(doc.mcpServers[MCP_SERVER_KEY]);
  const old = structuredClone(current);
  old.command = join(root, 'Cellar/node/22.0.0/bin/node');
  old.env.API_SETUP_BINDING = setupBindingId(root, old);
  doc.mcpServers[MCP_SERVER_KEY] = old;
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(doc, null, 2) + '\n');
  const codex = join(root, '.codex/config.toml');
  writeFileSync(codex, readFileSync(codex, 'utf8').replace(JSON.stringify(current.command), JSON.stringify(old.command))
    .replaceAll(current.env.API_SETUP_BINDING, old.env.API_SETUP_BINDING));
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(current.env.API_SETUP_BINDING, old.env.API_SETUP_BINDING));
  }
  return { root, run, current, old };
}

for (const kind of ['symlink', 'hardlink', 'readonly', 'malformed', 'edited-marker']) {
  test(`runtime repair refuses a ${kind} second pointer before changing any earlier file`, t => {
    const { root, run } = fixture(t);
    const path = join(root, 'CLAUDE.md'), external = join(root, 'preserved-guidance.txt');
    const original = readFileSync(path, 'utf8');
    writeFileSync(external, original);
    if (kind === 'symlink' || kind === 'hardlink') {
      rmSync(path);
      if (kind === 'symlink') symlinkSync(external, path); else linkSync(external, path);
    } else if (kind === 'readonly') chmodSync(path, 0o444);
    else if (kind === 'malformed') writeFileSync(path, original.replace(POINTER_END, ''));
    else writeFileSync(path, original.replace('Expected tool description marker:', 'Team-owned tool marker:'));
    const before = new Map([...PATHS, 'preserved-guidance.txt'].map(file => [file, readFileSync(join(root, file), 'utf8')]));
    const result = run('doctor', '--offline', '--repair', '--json');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    const repair = report.checks.find(row => row.name === 'mcp-repair');
    assert.equal(repair.state, 'FAIL');
    assert.match(repair.detail, /No files changed/);
    for (const [file, bytes] of before) assert.equal(readFileSync(join(root, file), 'utf8'), bytes, `${kind}: ${file}`);
    assert.equal(report.request_target, undefined);
    if (kind === 'readonly') chmodSync(path, 0o644);
  });
}

test('runtime repair preserves all wiring when a vanished server path is not recognized as generated', t => {
  const { root, run } = fixture(t);
  const path = join(root, '.mcp.json'), doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.mcpServers[MCP_SERVER_KEY].args = [join(root, 'removed-cache/server.mjs')];
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  const before = new Map(PATHS.map(file => [file, readFileSync(join(root, file), 'utf8')]));
  const result = run('doctor', '--offline', '--repair', '--json');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find(row => row.name === 'mcp-repair').state, 'FAIL');
  assert.equal(report.checks.find(row => row.name === 'mcp').state, 'FAIL');
  for (const [file, bytes] of before) assert.equal(readFileSync(join(root, file), 'utf8'), bytes, file);
});

test('runtime repair changes only the managed setup marker and preserves identical-looking neighboring prose', t => {
  const { root, run, current, old } = fixture(t);
  const oldLine = `Expected tool description marker: Setup binding: ${old.env.API_SETUP_BINDING}`;
  const newLine = `Expected tool description marker: Setup binding: ${current.env.API_SETUP_BINDING}`;
  const snapshots = new Map();
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(root, file);
    const block = readFileSync(path, 'utf8').replace(POINTER_BEGIN, POINTER_BEGIN + '\nTeam instruction: keep the API owner attribution.');
    const before = oldLine + '\nOutside the managed block.\n' + block + '\n' + oldLine + '\n';
    writeFileSync(path, before);
    snapshots.set(file, { before, expected: oldLine + '\nOutside the managed block.\n' + block.replace(oldLine, newLine) + '\n' + oldLine + '\n' });
  }
  const result = run('doctor', '--offline', '--repair', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find(row => row.name === 'mcp-repair').state, 'PASS');
  assert.equal(report.checks.find(row => row.name === 'mcp').state, 'PASS');
  for (const [file, { expected }] of snapshots) assert.equal(readFileSync(join(root, file), 'utf8'), expected, file);
});
