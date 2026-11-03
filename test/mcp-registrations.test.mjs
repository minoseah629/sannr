import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync,  existsSync, realpathSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const sentinel = 'sk_live_' + 'a'.repeat(32);
const server = `import { appendFileSync } from 'node:fs';
if (process.argv[2] !== 'argument with spaces' || process.argv[3] !== '--json' || process.env.REGISTRATION_TOKEN !== '${sentinel}') process.exit(13);
appendFileSync('launches.log', process.env.REGISTRATION_HOST + '\\n');
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => { buffer += chunk; const lines = buffer.split('\\n'); buffer = lines.pop(); for (const line of lines) {
 const msg = JSON.parse(line); appendFileSync('methods.log', msg.method + '\\n');
 if (!('id' in msg)) continue;
 let result = {};
 if (msg.method === 'initialize') result = { protocolVersion: '2025-11-25', serverInfo: { name: 'registration-fixture', version: '1' }, capabilities: { tools: {} } };
 else if (msg.method === 'tools/list') result = { tools: [{ name: 'lookup', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }] };
 else if (msg.method === 'resources/list') result = { resources: [] };
 else if (msg.method === 'prompts/list') result = { prompts: [] };
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
}});
`;
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-registrations-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'registered-server.mjs'), server);
  return root;
}
function put(root, file, text) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
const entry = host => ({ command: process.execPath, args: ['registered-server.mjs', 'argument with spaces', '--json'], env: { REGISTRATION_TOKEN: sentinel, REGISTRATION_HOST: host } });
function allHosts(root) {
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { claude: entry('claude') } }));
  put(root, '.codex/config.toml', `[mcp_servers.'codex.with.dot']\ncommand = ${JSON.stringify(process.execPath)}\nargs = [\n 'registered-server.mjs', # keep arguments literal\n 'argument with spaces', '--json',\n]\n[mcp_servers.'codex.with.dot'.env]\nREGISTRATION_TOKEN = '${sentinel}'\nREGISTRATION_HOST = 'codex'\n`);
  put(root, '.cursor/mcp.json', JSON.stringify({ mcpServers: { cursor: entry('cursor') } }));
  put(root, '.vscode/mcp.json', `// project registrations\n${JSON.stringify({ servers: { vscode: { type: 'stdio', ...entry('vscode') } } }).replace(/}}$/, '},}')}`);
}
const run = (root, args = []) => spawnSync(process.execPath, [cli, 'mcp', 'inspect', ...args], { cwd: root, encoding: 'utf8', timeout: 20_000 });

test('MCP-1b zero-argument inspection launches all four host registrations exactly and stores labels only', t => {
  const root = scratch(t); allHosts(root);
  const out = run(root);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(readFileSync(join(root, 'launches.log'), 'utf8').trim().split('\n').sort(), ['claude', 'codex', 'cursor', 'vscode']);
  assert.doesNotMatch(readFileSync(join(root, 'methods.log'), 'utf8'), /tools\/call/);
  assert.equal(readFileSync(join(root, 'methods.log'), 'utf8').split('\n').filter(method => method === 'tools/list').length, 4);
  const text = readFileSync(join(root, LAYOUT.context), 'utf8');
  const records = JSON.parse(text).mcp_inspections;
  assert.deepEqual(records.map(x => x.server.label).sort(), ['claude', 'codex.with.dot', 'cursor', 'vscode']);
  assert.equal(records.every(x => x.server.name === 'registration-fixture'), true);
  for (const value of [sentinel, process.execPath, 'registered-server.mjs', 'argument with spaces', 'REGISTRATION_TOKEN']) assert.equal(text.includes(value), false, value);
  assert.equal(out.stdout.includes(sentinel), false);
});

test('MCP-1b --only chooses a registration key without consuming the server arguments', t => {
  const root = scratch(t); allHosts(root);
  const out = run(root, ['--only', 'codex.with.dot']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readFileSync(join(root, 'launches.log'), 'utf8'), 'codex\n');
  assert.equal(JSON.parse(readFileSync(join(root, LAYOUT.context), 'utf8')).mcp_inspections[0].server.label, 'codex.with.dot');
});

test('MCP-1b --dry-run names registrations and unresolved commands without a spawn or record', t => {
  const root = scratch(t); allHosts(root);
  const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  config.mcpServers.missing = { command: 'sannr-fixture-command-does-not-exist', args: [] };
  put(root, '.mcp.json', JSON.stringify(config));
  const out = run(root, ['--dry-run']);
  assert.equal(out.status, 0, out.stderr);
  for (const key of ['claude', 'codex.with.dot', 'cursor', 'vscode', 'missing']) assert.match(out.stdout, new RegExp(key));
  assert.match(out.stdout, /MCP_COMMAND_NOT_FOUND/);
  assert.equal(existsSync(join(root, 'launches.log')), false);
  assert.equal(existsSync(join(root, LAYOUT.context)), false);
  assert.equal(out.stdout.includes(sentinel), false);
  assert.equal(out.stdout.includes(process.execPath), false);
});

test('MCP-1b unavailable and unsupported registrations are named while working registrations continue', t => {
  const root = scratch(t);
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { missing: { command: 'sannr-fixture-command-does-not-exist' }, remote: { url: 'https://example.invalid/mcp' }, okay: entry('okay') } }));
  const out = run(root);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /missing.*MCP_COMMAND_NOT_FOUND/);
  assert.match(out.stdout, /remote.*MCP_REGISTRATION_UNSUPPORTED/);
  assert.equal(readFileSync(join(root, 'launches.log'), 'utf8'), 'okay\n');
});

test('MCP-1b registration JSON and summary never expose launch material', t => {
  const root = scratch(t); allHosts(root);
  const out = run(root, ['--only', 'claude', '--json', '--summary', join(root, 'summary.md')]);
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.registrations[0].key, 'claude');
  assert.equal(report.registrations[0].record.server.label, 'claude');
  for (const raw of [out.stdout, readFileSync(join(root, 'summary.md'), 'utf8')]) {
    assert.equal(raw.includes(sentinel), false);
    assert.equal(raw.includes(process.execPath), false);
    assert.equal(raw.includes('registered-server.mjs'), false);
  }
});

test('MCP-1b unknown --only is a named gap and registration batches cannot execute tools', t => {
  const root = scratch(t); allHosts(root);
  const missing = run(root, ['--only', 'not-registered']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /not-registered.*MCP_REGISTRATION_NOT_FOUND/);
  const execute = run(root, ['--execute', 'lookup']);
  assert.equal(execute.status, 1);
  assert.match(execute.stderr, /MCP_REGISTRATION_ENUMERATE_ONLY/);
  assert.equal(existsSync(join(root, 'launches.log')), false);
});

test('MCP-1b storage discards env and cwd before scanning or promotion, retaining command secret refusal', async t => {
  const root = scratch(t);
  const { storeMcpInspection } = await import('../lib/mcp-inspect.mjs');
  const inspection = { server: { name: 'fixture', label: 'fixture' }, declared: { tools: [] }, env: { PLAIN: 'PLAIN_ENV_NOT_STORED', SECRET: sentinel }, cwd: 'PRIVATE_WORKING_DIRECTORY', command: process.execPath, args: ['PRIVATE_ARGUMENT'] };
  storeMcpInspection(root, inspection);
  const bytes = readFileSync(join(root, LAYOUT.context), 'utf8');
  for (const forbidden of [sentinel, 'PLAIN_ENV_NOT_STORED', 'PRIVATE_WORKING_DIRECTORY', process.execPath, 'PRIVATE_ARGUMENT']) assert.equal(bytes.includes(forbidden), false);
  assert.throws(() => storeMcpInspection(root, { ...inspection, command: sentinel }), { code: 'MCP_LITERAL_SECRET_REFUSED' });
});

test('MCP-1b discovery preserves host duplicates and inline/dotted TOML strings and env exactly', async t => {
  const root = scratch(t);
  const { discoverMcpRegistrations } = await import('../lib/mcp-registrations.mjs');
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { same: entry('claude') } }));
  put(root, '.codex/config.toml', `model = "surrounding-setting"\ndeveloper_instructions = """\n[mcp_servers.fake]\ncommand = 'ignore this string'\n"""\nmcp_servers.same = { command = ${JSON.stringify(process.execPath)}, args = ['registered-server.mjs', 'argument with spaces', '--json'], env = { REGISTRATION_TOKEN = '${sentinel}', REGISTRATION_HOST = 'codex', ESCAPED = "line\\nquote\\\"" } }\n`);
  const rows = discoverMcpRegistrations(root);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(x => x.key), ['same', 'same']);
  assert.equal(rows[1].env.ESCAPED, 'line\nquote"');
  assert.deepEqual(rows[1].args, entry('codex').args);
  assert.equal(rows[1].command, process.execPath);
});

test('MCP-1b discovery bounds configs and keys with explicit gaps', async t => {
  const root = scratch(t);
  const { discoverMcpRegistrations, MAX_MCP_REGISTRATIONS } = await import('../lib/mcp-registrations.mjs');
  put(root, '.mcp.json', JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: MAX_MCP_REGISTRATIONS + 1 }, (_, i) => [`server${i}`, entry('fixture')])) }));
  assert.equal(discoverMcpRegistrations(root)[0].code, 'MCP_REGISTRATION_LIMIT');
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { ['x'.repeat(201)]: entry('fixture'), [sentinel]: entry('fixture'), broken: { command: process.execPath, args: 'not an array' } } }));
  const rows = discoverMcpRegistrations(root);
  assert.deepEqual(rows.map(x => x.code), ['MCP_REGISTRATION_KEY_INVALID', 'MCP_REGISTRATION_KEY_INVALID', 'MCP_REGISTRATION_INVALID']);
  assert.equal(JSON.stringify(rows).includes(sentinel), false);
  put(root, '.mcp.json', ' '.repeat(1024 * 1024 + 1));
  assert.equal(discoverMcpRegistrations(root)[0].code, 'MCP_REGISTRATION_LIMIT');
});

test('MCP-1b command lookup honors registered PATH and cwd without spawning for discovery', async t => {
  const root = scratch(t);
  const { discoverMcpRegistrations } = await import('../lib/mcp-registrations.mjs');
  const { chmodSync } = await import('node:fs');
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'fixture-command'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'tools', 'fixture-command'), 0o755);
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { custom: { command: 'fixture-command', args: [], env: { PATH: 'tools' } } } }));
  const row = discoverMcpRegistrations(root)[0];
  assert.equal(row.code, undefined);
  assert.equal(row.command, 'fixture-command');
  assert.equal(row.env.PATH, 'tools');
  assert.equal(row.cwd, root);
  assert.equal(existsSync(join(root, 'launches.log')), false);
});

test('MCP-1b disabled host registrations are named and never spawned', async t => {
  const root = scratch(t);
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { claude: { ...entry('claude'), disabled: true } } }));
  put(root, '.codex/config.toml', `[mcp_servers.codex]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ['registered-server.mjs']\nenabled = false\n`);
  const out = run(root, ['--json']);
  assert.equal(out.status, 1);
  assert.deepEqual(JSON.parse(out.stdout).registrations.map(row => [row.key, row.code]), [['claude', 'MCP_REGISTRATION_DISABLED'], ['codex', 'MCP_REGISTRATION_DISABLED']]);
  assert.equal(existsSync(join(root, 'launches.log')), false);
  assert.equal(existsSync(join(root, LAYOUT.context)), false);
});

test('MCP-1b summaries cannot overwrite registration inputs and refuse before spawning', t => {
  const root = scratch(t); allHosts(root);
  for (const file of ['.mcp.json', '.codex/config.toml', '.cursor/mcp.json', '.vscode/mcp.json']) {
    const before = readFileSync(join(root, file), 'utf8');
    const out = run(root, ['--only', 'claude', '--summary', join(root, file)]);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /MCP_SUMMARY_UNSAFE_PATH/);
    assert.equal(readFileSync(join(root, file), 'utf8'), before);
    assert.equal(existsSync(join(root, 'launches.log')), false);
    assert.equal(existsSync(join(root, LAYOUT.context)), false);
  }
});

test('MCP-1b malformed TOML numbers and extensions of inline tables are named config gaps', async t => {
  const root = scratch(t);
  const { discoverMcpRegistrations } = await import('../lib/mcp-registrations.mjs');
  const registration = `[mcp_servers.reader]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ['registered-server.mjs']\n`;
  const invalid = [
    `setting = 1+2\n${registration}`,
    `setting = 1e+\n${registration}`,
    `${registration}env = { ONE = 'one' }\n[mcp_servers.reader.env]\nTWO = 'two'\n`,
    `mcp_servers.reader = { command = ${JSON.stringify(process.execPath)} }\n[mcp_servers.reader]\nargs = ['registered-server.mjs']\n`,
    `${registration}env = { ONE = 'one' }\nenv.TWO = 'two'\n`,
  ];
  for (const config of invalid) {
    put(root, '.codex/config.toml', config);
    const rows = discoverMcpRegistrations(root);
    assert.deepEqual(rows.map(row => row.code), ['MCP_REGISTRATION_CONFIG_INVALID']);
  }
});

test('MCP-1b nonregular registration inputs never block or read device streams', { skip: process.platform === 'win32' }, async t => {
  const root = scratch(t);
  const { symlinkSync } = await import('node:fs');
  const path = join(root, '.mcp.json');
  const made = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const fifo = spawnSync(process.execPath, [cli, 'mcp', 'inspect', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(fifo.error, undefined, 'a named config gap must complete without blocking on a FIFO');
  assert.equal(JSON.parse(fifo.stdout).registrations[0].code, 'MCP_REGISTRATION_CONFIG_INVALID');
  rmSync(path);
  symlinkSync('/dev/zero', path);
  const device = spawnSync(process.execPath, [cli, 'mcp', 'inspect', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(device.error, undefined, 'device contents must never be read');
  assert.equal(JSON.parse(device.stdout).registrations[0].code, 'MCP_REGISTRATION_CONFIG_INVALID');
});
