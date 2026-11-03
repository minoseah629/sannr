import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_KEY, NPM_PACKAGE, POINTER_BEGIN, POINTER_END, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { stableNodeCommand } from '../lib/node-runtime.mjs';
import { CODEX_TOOL_TIMEOUT_SEC, installedProjectEntry } from '../lib/connect.mjs';
import { LIBRARIAN_MCP_SERVER_KEY, librarianServerEntry, librarianTargets } from '../lib/librarian.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'unwire-release-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), home = join(base, 'home');
  mkdirSync(root); mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'state'), API_USAGE_LOG: '' };
  const invoke = (command, args = [], packageRoot = source, extra = {}) => {
    const result = spawnSync(process.execPath, [join(packageRoot, 'bin/cli.mjs'), command, ...args],
      { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return args.includes('--json') ? JSON.parse(result.stdout) : result.stdout;
  };
  const packageCopy = name => {
    const dest = join(base, name, 'node_modules', ...NPM_PACKAGE.split('/'));
    mkdirSync(dest, { recursive: true });
    for (const path of ['bin', 'lib', 'skill', 'docs', 'server.mjs', 'package.json'])
      cpSync(join(source, path), join(dest, path), { recursive: true });
    return dest;
  };
  return { root, base, invoke, packageCopy };
}

function seedLegacyLibrarian(root) {
  const entry = installedProjectEntry(root);
  assert.ok(entry);
  const file = join(root, '.mcp.json'), config = JSON.parse(readFileSync(file));
  config.mcpServers[LIBRARIAN_MCP_SERVER_KEY] = librarianServerEntry(entry);
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  const agents = librarianTargets(root, entry, { toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC });
  for (const agent of agents) {
    mkdirSync(dirname(agent.to), { recursive: true });
    writeFileSync(agent.to, agent.body);
  }
  return agents;
}

test('connect guidance shares the stable registration runtime and gives teammates installation guidance', t => {
  const { root, invoke } = fixture(t);
  const report = invoke('connect', ['--json']);
  const entry = JSON.parse(readFileSync(join(root, '.mcp.json'))).mcpServers[MCP_SERVER_KEY];
  assert.equal(entry.command, stableNodeCommand());
  assert.ok(report.command_resolution.local.command.startsWith(entry.command + ' '));
  assert.ok(!report.command_resolution.local.command.includes('/Cellar/'));
  assert.equal(report.command_resolution.portable.available, false);
  assert.match(report.note, /selected CLI version.*connect/);
  assert.ok(!report.note.includes(report.command_resolution.portable.command),
    'a source-only installation must not promise a missing portable executable');
  assert.doesNotMatch(report.note, /@alpha\b/);
  assert.ok(!report.note.includes(source), 'teammates must not copy this machine package path');
});

test('ordinary unwire removes active registrations while retaining knowledge and unrelated config', t => {
  const { root, invoke } = fixture(t);
  const neighbor = { command: 'neighbor-tool', args: ['serve'] };
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ team: true, mcpServers: { neighbor } }));
  invoke('connect', ['--json']);
  const keep = [LAYOUT.context, LAYOUT.environments, join(LAYOUT.evidence, 'kept.json')];
  for (const path of keep) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), '{}\n'); }
  const report = invoke('unwire', ['--json']);
  const config = JSON.parse(readFileSync(join(root, '.mcp.json')));
  assert.deepEqual(config, { team: true, mcpServers: { neighbor } });
  assert.equal(readFileSync(join(root, '.codex/config.toml'), 'utf8'), '');
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '');
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n',
    'an unmarked import bridge remains available for future team instructions');
  for (const path of keep) assert.equal(readFileSync(join(root, path), 'utf8'), '{}\n');
  assert.equal(report.complete, true);
  assert.deepEqual(report.left, []);
  assert.match(report.note, /knowledge, configuration and evidence.*retained/);
  assert.match(report.next, /reload|restart/i);
});

test('unwire from a new package removes unchanged legacy librarian wiring after the old cache disappears', t => {
  const { root, invoke, packageCopy } = fixture(t);
  const previous = packageCopy('cache-a'), current = packageCopy('cache-b');
  invoke('connect', ['--json'], previous);
  const agents = seedLegacyLibrarian(root);
  rmSync(previous, { recursive: true });
  const report = invoke('unwire', ['--json'], current, { API_BASE_URL: 'http://127.0.0.1:9' });
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'))).mcpServers, {});
  assert.equal(report.librarian_mcp.action, 'removed');
  assert.ok(report.agents.every(row => row.action === 'removed'));
  for (const agent of agents) assert.equal(existsSync(agent.to), false);
  assert.equal(report.complete, true);
});

test('cross-install unwire retains edited restricted permissions and agent bodies as named leftovers', t => {
  const { root, invoke, packageCopy } = fixture(t);
  const previous = packageCopy('cache-a'), current = packageCopy('cache-b');
  invoke('connect', ['--json'], previous);
  const agents = seedLegacyLibrarian(root);
  const path = join(root, '.mcp.json'), config = JSON.parse(readFileSync(path));
  config.mcpServers[LIBRARIAN_MCP_SERVER_KEY].env.API_REQUEST_READ_ONLY = '0';
  writeFileSync(path, JSON.stringify(config));
  const codex = agents.find(row => row.host === 'codex');
  const edited = codex.body + '\n# User-owned edit stays.\n';
  writeFileSync(codex.to, edited);
  rmSync(previous, { recursive: true });
  const report = invoke('unwire', ['--json'], current);
  assert.equal(report.complete, false);
  assert.equal(report.librarian_mcp.action, 'left');
  assert.deepEqual(JSON.parse(readFileSync(path)).mcpServers[LIBRARIAN_MCP_SERVER_KEY], config.mcpServers[LIBRARIAN_MCP_SERVER_KEY]);
  assert.equal(readFileSync(codex.to, 'utf8'), edited);
  assert.match(report.next, /Review the reported leftovers/);
});

test('unwire removes only the pointer region and preserves a user heading and neighboring whitespace', t => {
  const { root, invoke } = fixture(t);
  writeFileSync(join(root, 'AGENTS.md'), '# Team\n');
  writeFileSync(join(root, 'CLAUDE.md'), '# Claude team\n');
  invoke('connect', ['--json']);
  const retained = ['AGENTS.md', 'CLAUDE.md'].map(file => {
    const path = join(root, file), before = readFileSync(path, 'utf8');
    const start = before.indexOf(POINTER_BEGIN), end = before.indexOf(POINTER_END) + POINTER_END.length;
    assert.notEqual(start, -1, `${file} must exercise full-block removal`);
    return { path, expected: before.slice(0, start) + before.slice(end) };
  });
  invoke('unwire', ['--json']);
  for (const { path, expected } of retained) assert.equal(readFileSync(path, 'utf8'), expected);
  assert.match(retained[0].expected, /^# Team\n/);
  assert.match(retained[1].expected, /^# Claude team\n/);
});

test('unwire human output exposes an unrelated same-key registration instead of implying removal', t => {
  const { root, invoke } = fixture(t);
  const config = { mcpServers: { [MCP_SERVER_KEY]: { command: 'my-tool', args: ['custom-entry'] } } };
  const path = join(root, '.mcp.json'), bytes = JSON.stringify(config);
  writeFileSync(path, bytes);
  const text = invoke('unwire');
  assert.match(text, /registration\s+LEFT in \.mcp\.json/);
  assert.match(text, /Review the reported leftovers/);
  assert.equal(readFileSync(path, 'utf8'), bytes);
});
