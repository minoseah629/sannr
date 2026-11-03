import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { LAYOUT, LEGACY_LAYOUT } from '../lib/layout.mjs';
import { PRODUCT, HOME_ENV_NAME, POINTER_BEGIN, POINTER_END, SKILL_NAMES, CI_WORKFLOW_BASENAME, CONTEXT_BASENAME } from '../lib/brand.mjs';
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const exec = promisify(execFile);
const spec = { openapi: '3.0.0', info: { title: 'Layout fixture', version: '1' }, paths: {
  '/health': { get: { operationId: 'health', responses: { '200': { description: 'ready', content: {
    'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['ready'] } } } },
  } } } } },
} };
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'layout-commands-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'openapi.json'), JSON.stringify(spec));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_')));
  Object.assign(env, { [HOME_ENV_NAME]: join(root, 'home'), API_USAGE_LOG: '' });
  const run = async (...args) => {
    try { return { code: 0, ...(await exec(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' })) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  return { root, run, env };
}
function inventory(root, path = '') {
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard', ...(path ? [path] : [])], { cwd: root, encoding: 'utf8' });
}
test('DOTSANNR-1 fresh feedback creates its layout before writing the report', async t => {
  const { root, run } = project(t);
  const result = await run('feedback');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(root, LAYOUT.feedback)));
  assert.ok(existsSync(join(root, LAYOUT.readme)));
  assert.match(readFileSync(join(root, LAYOUT.gitignore), 'utf8'), /\/evidence\//);
});

test('DOTSANNR-1 fresh start and connect write a portable README, canonical skills and an ignored evidence half', async t => {
  const specimens = [];
  for (const command of ['start', 'connect']) {
    const { root, run } = project(t);
    const result = await run(command, '--json');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const readme = readFileSync(join(root, LAYOUT.readme), 'utf8');
    assert.doesNotMatch(readme, /\/Users\/|\/private\/|[A-Z]:\\/);
    // alpha.10 cold qualification closed connect's leftover single-store path:
    // both documented first-install entrypoints now create the same named stack.
    const context = `${LAYOUT.collection}/layout-fixture/${CONTEXT_BASENAME}`;
    assert.ok(readme.includes(`${LAYOUT.collection}/<name>/${CONTEXT_BASENAME}`));
    assert.ok(existsSync(join(root, context)));
    assert.equal(existsSync(join(root, LAYOUT.context)), false, 'fresh setup never creates the retired store');
    for (const name of Object.values(SKILL_NAMES)) {
      assert.ok(existsSync(join(root, LAYOUT.skills, name, 'SKILL.md')), name);
      assert.ok(existsSync(join(root, '.agents', 'skills', name, 'SKILL.md')), name);
    }
    const evidence = join(root, LAYOUT.evidence, 'fixture.json');
    writeFileSync(evidence, '{}');
    assert.equal(execFileSync('git', ['check-ignore', '--no-index', LAYOUT.evidence + '/fixture.json'], { cwd: root, encoding: 'utf8' }).trim(), LAYOUT.evidence + '/fixture.json');
    assert.ok(inventory(root).includes(context));
    assert.ok(!inventory(root).includes(LAYOUT.evidence + '/fixture.json'));
    for (const file of ['AGENTS.md', '.mcp.json', '.codex/config.toml'])
      assert.ok(readFileSync(join(root, file), 'utf8').includes(LAYOUT.directory), file);
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n', 'new Claude guidance imports the canonical pointer');
    specimens.push({ command, exit: result.code, readme, committed_candidates: inventory(root, LAYOUT.directory).trim().split('\n'),
      ignored: LAYOUT.evidence + '/fixture.json',
      pointer: readFileSync(join(root, 'AGENTS.md'), 'utf8').split('\n').filter(line => line.includes(context) || line.includes(LAYOUT.readme)),
      registrations: ['.mcp.json', '.codex/config.toml'].map(file => ({ file,
        evidence_line: readFileSync(join(root, file), 'utf8').split('\n').find(line => line.includes('API_EVIDENCE')).replaceAll(root, '<project>') })) });
  }
  if (process.env.DOTSANNR_SPECIMEN_LOG) writeFileSync(process.env.DOTSANNR_SPECIMEN_LOG + '.fresh.json', JSON.stringify(specimens, null, 2) + '\n');
});

test('DOTSANNR-1 migrated doctor learn note show graph export view and feedback use the layout', async t => {
  const { root, run } = project(t);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ready' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(join(root, LEGACY_LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: {
    local: { baseUrl: `http://127.0.0.1:${server.address().port}`, contract: 'openapi.json' },
  } }));
  writeFileSync(join(root, LEGACY_LAYOUT.context), JSON.stringify({ v: 0, api: {
    name: 'Layout fixture', contract: 'openapi.json', contract_digest: null,
  }, operations: { 'GET /health': { declared: true } } }));
  writeFileSync(join(root, LEGACY_LAYOUT.skillGuide), '# Existing convention\n');
  writeFileSync(join(root, LEGACY_LAYOUT.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture/layout', name: 'Layout fixture' }, nodes: [] }));
  writeFileSync(join(root, 'AGENTS.md'), `${POINTER_BEGIN}\nRead ${LEGACY_LAYOUT.context} and ${LEGACY_LAYOUT.skillGuide}.\n${POINTER_END}\n`);
  const rows = [];
  for (const args of [['migrate', '--json'], ['connect', '--json'], ['doctor', '--json'], ['learn', '--json'],
    ['note', 'GET /health', 'Requires a declared status field'], ['show', 'GET /health'], ['graph', 'export', '--json'],
    ['view', '--json'], ['feedback']]) {
    const result = await run(...args);
    assert.equal(result.code, 0, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
    rows.push({ command: args.join(' '), output: result.stdout.replaceAll(root, '<project>') });
  }
  assert.ok(readFileSync(join(root, LAYOUT.collection, 'layout-fixture', CONTEXT_BASENAME), 'utf8').includes('Requires a declared status field'));
  assert.ok(existsSync(join(root, LAYOUT.graphSnapshot)));
  assert.ok(existsSync(join(root, LAYOUT.feedback)));
  for (const path of Object.values(LEGACY_LAYOUT)) {
    if (path === LAYOUT.directory || path.startsWith(LAYOUT.directory + '/')) continue;
    assert.equal(existsSync(join(root, path)), false, `legacy stray ${path}`);
  }
  // Optional report capture is explicitly outside the repository and contains
  // only fixture metadata and allowed contract-enum observations.
  if (process.env.DOTSANNR_SPECIMEN_LOG) writeFileSync(process.env.DOTSANNR_SPECIMEN_LOG, JSON.stringify(rows, null, 2) + '\n');
});
