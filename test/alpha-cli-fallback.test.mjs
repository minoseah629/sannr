import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedNpxCommand } from '../lib/advertisement.mjs';
import { planSkills, planSkillRemoval, renderSkill, shippedSkillDigest, SKILL_SOURCES } from '../lib/connect.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { NPM_PACKAGE, PRODUCT, SKILL_NAMES } from '../lib/brand.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'))).version;
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-cli-fallback-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t) {
  const root = scratch(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  write(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Fixture', version: '1' },
    paths: { '/orders': { get: { responses: { 200: { description: 'ok' } } } } } }));
  const guard = join(root, 'no-network.mjs');
  write(guard, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module';
    const denied=()=>{throw new Error('NETWORK_FORBIDDEN_DURING_SETUP');}; globalThis.fetch=denied;
    for(const module of [http,https,net,tls]) for(const name of ['request','get','connect','createConnection','createServer']) if(typeof module[name]==='function') module[name]=denied; syncBuiltinESMExports();`);
  const env = { ...process.env, API_CONTEXT_OFF: '',
    SANNR_HOME: join(root, 'home'), NODE_OPTIONS: `--import=${guard}`, NO_COLOR: '1', TERM: 'dumb' };
  for (const key of ['API_BASE_URL', 'API_CONFIG', 'API_ENV', 'API_AUTH', 'API_CONTRACT', 'API_CONTEXT_DIR']) delete env[key];
  const run = (args, cli = join(ROOT, 'bin/cli.mjs')) => JSON.parse(execFileSync(process.execPath, [cli, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 }));
  return { root, run, env };
}

test('only an npm installation with an exact valid version gets a portable npx fallback', t => {
  const root = scratch(t), installed = join(root, 'node_modules', ...NPM_PACKAGE.split('/'));
  write(join(installed, 'package.json'), JSON.stringify({ name: NPM_PACKAGE, version: VERSION }));
  assert.equal(installedNpxCommand(installed), `npx --yes ${NPM_PACKAGE}@${VERSION}`);
  assert.equal(installedNpxCommand(ROOT), null, 'a development checkout must not advertise unpublished source as registry bytes');
  for (const value of [{ name: NPM_PACKAGE, version: 'alpha' }, { name: NPM_PACKAGE, version: '1.2.3;false' },
    { name: '@other/tool', version: '1.2.3' }]) {
    write(join(installed, 'package.json'), JSON.stringify(value));
    assert.equal(installedNpxCommand(installed), null);
  }
});

test('connect from an npm package advertises runnable pinned skill commands without a local shim', t => {
  const { root, run } = fixture(t), installed = join(root, 'cache/node_modules', ...NPM_PACKAGE.split('/'));
  for (const path of ['bin', 'lib', 'skill', 'server.mjs', 'package.json'])
    cpSync(join(ROOT, path), join(installed, path), { recursive: true });
  const cli = join(installed, 'bin/cli.mjs');
  const report = run(['connect', '--json'], cli);
  assert.deepEqual(report.omitted, []);
  assert.equal(report.command_resolution.portable.command, `npx --yes ${NPM_PACKAGE}@${VERSION}`);
  assert.equal(report.command_resolution.portable.available, true);
  assert.ok(report.note.includes(`\`npx --yes ${NPM_PACKAGE}@${VERSION} connect\``),
    'teammates must get the installed version rather than a moving release tag');
  assert.equal(report.setup.api.state, 'not_checked');
  assert.equal(report.setup.context.verified, 0);
  const skill = readFileSync(join(root, '.agents/skills', SKILL_NAMES.write, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(`npx --yes ${NPM_PACKAGE}@${VERSION} graph record`));
  assert.ok(skill.includes(`npx --yes ${NPM_PACKAGE}@${VERSION} show`));
  assert.ok(!skill.includes(installed));
  assert.ok(run(['connect', '--json'], cli).skills.every(row => row.action === 'unchanged'));
});

test('first-session HTTP note and retrieval work without an MCP server or API traffic', t => {
  const { root, run, env } = fixture(t);
  createFixtureStack(root,{contract:'openapi.json'});
  const setup = run(['connect', '--json']);
  assert.equal(setup.setup.context.state, 'available');
  assert.equal(setup.setup.context.verified, 0);
  const invocation = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'bin/cli.mjs'))}`;
  const skill = renderSkill(SKILL_SOURCES[1], invocation);
  const note = 'The task owner says the list excludes archived orders; runtime behavior is unverified.';
  const noteTemplate = skill.match(/^(.+ note "<METHOD \/path>" "<one sentence>")$/m)?.[1];
  assert.ok(noteTemplate, 'the installed write skill must contain an executable note template');
  const capture = JSON.parse(execFileSync('/bin/sh', ['-c', noteTemplate
    .replace('<METHOD /path>', 'GET /orders').replace('<one sentence>', note)], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(capture.recorded, note);
  const showTemplate = skill.match(/`([^`]+ show "<METHOD \/path>")`/)?.[1];
  assert.ok(showTemplate);
  const retrieved = JSON.parse(execFileSync('/bin/sh', ['-c', showTemplate.replace('<METHOD /path>', 'GET /orders')],
    { cwd: root, env, encoding: 'utf8' }));
  assert.ok(retrieved.notes.includes(note));
  assert.notEqual(retrieved.confidence, 'verified');
});

test('first-session graph commands retain an authored claim and its actual scope without API traffic', t => {
  const { root, run, env } = fixture(t);
  createFixtureStack(root,{contract:'openapi.json'});
  write(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture/web', name: 'Web' }, nodes: [],
    dependencies: [{ from: 'repo', to: 'fixture/orders#api', kind: 'calls' }],
    context: { providers: [{ node: 'fixture/orders#api', provider: 'orders', environment: 'staging', protocol: 'http' }] } }));
  run(['connect', '--json']);
  const invocation = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'bin/cli.mjs'))}`;
  const skill = renderSkill(SKILL_SOURCES[1], invocation);
  const substitute = command => command.replaceAll('<provider-node>', 'fixture/orders#api')
    .replaceAll('<METHOD /path>', 'GET /orders').replaceAll('<environment>', 'staging')
    .replaceAll('<source attribution and unverified lesson>', 'Task owner says archived orders are excluded; runtime behavior is unverified.');
  const recordTemplate = skill.match(/`([^`]+ graph record "<provider-node>"[^`]+)`/)?.[1];
  const queryTemplate = skill.match(/^(.+ graph context "<provider-node>"[^\n]+)$/m)?.[1];
  assert.ok(recordTemplate && queryTemplate);
  const runTemplate = command => JSON.parse(execFileSync('/bin/sh', ['-c', substitute(command)],
    { cwd: root, env, encoding: 'utf8' }));
  assert.equal(runTemplate(recordTemplate).verification, 'external-claim');
  const saved = readFileSync(fixtureContextFile(root),'utf8');
  assert.ok(Object.values(JSON.parse(saved).api_context.operations).some(entry =>
    entry.identity.stack === 'fixture' && entry.observations.some(observation => observation.basis === 'authored')));
  // STACKS-2 owns graph aggregation. Keep this existing graph reader control
  // on a saved historical projection, after proving the current scoped write.
  write(join(root, LAYOUT.context), saved);
  const retrieved = runTemplate(queryTemplate);
  assert.equal(retrieved.knowledge[0].verification, 'external-claim');
  assert.equal(retrieved.knowledge[0].basis, 'authored');
  assert.equal(retrieved.knowledge[0].environment, 'staging');
});

test('pre-alpha request and write skills upgrade while preserving authored edits', t => {
  const root = scratch(t);
  for (const [index, role] of ['request', 'write'].entries()) {
    const source = SKILL_SOURCES[index], oldSource = join(root, role, 'SKILL.md');
    write(oldSource, readFileSync(join(ROOT, `test/fixtures/${role}-context-252c215.txt`)));
    for (const invocation of [PRODUCT, './node_modules/.bin/' + PRODUCT, "node '/old install/bin/cli.mjs'", null]) {
      const path = join(root, '.agents/skills', SKILL_NAMES[role], 'SKILL.md');
      const previous = renderSkill(oldSource, invocation);
      write(path, previous);
      assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'updated');
      assert.equal(planSkillRemoval(root, [source]).find(row => row.host === 'codex').action, 'removed');
      write(path, previous + '\nTeam instruction: preserve source-owner attribution.\n');
      assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'differs');
    }
  }
});

test('pinned npx skill invocations can upgrade or unwire without claiming mixed commands', t => {
  const root = scratch(t);
  for (const source of SKILL_SOURCES) {
    const name = renderSkill(source).match(/^name: (.+)$/m)[1];
    const path = join(root, '.agents/skills', name, 'SKILL.md');
    const previous = renderSkill(source, `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.1`);
    write(path, previous);
    assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'updated');
    assert.equal(planSkillRemoval(root, [source]).find(row => row.host === 'codex').action, 'removed');
    const installed = renderSkill(source, `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.1`, { root, destination: path });
    write(path, installed);
    assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'updated');
    assert.equal(planSkillRemoval(root, [source]).find(row => row.host === 'codex').action, 'removed');
    write(path, previous + '\nTeam instruction: retain authorship.\n');
    assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'differs');
    write(path, previous.replace(`npx --yes ${NPM_PACKAGE}@0.1.0-alpha.1 `, `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.0 `));
    assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'differs');
  }
});

test('connect upgrades the exact published alpha.8 write guidance without API traffic and preserves an edited host copy', t => {
  const { root, run } = fixture(t);
  run(['connect', '--json']);
  // Reconstruct only the exact previous release regions, then pin the entire
  // rendered digest. An unrelated template change cannot silently become the
  // alpha.8 control; the complete frozen source also lives in the docs tests.
  // F-5 (2026-10-07) tightened session-tool selection. Undo those two
  // prose edits in this historical fixture; never re-pin the published bytes.
  // CONTEXT-2a (2026-10-09) adds stack facts. Remove only that new paragraph
  // as well; alpha.8 never shipped it and its pinned digest stays unchanged.
  // REVIEW-1 adds basis/review guidance before it. Omit that bounded region
  // from reconstruction too; the published hash below is never re-pinned.
  const current = readFileSync(SKILL_SOURCES[1], 'utf8')
    .replace(/\nFor new notes, record `--basis KIND`[\s\S]*?(?=\nWhen a lesson applies across the API,)/u, '')
    .replace('\nWhen a lesson applies across the API, record it once with\n' +
      '`sannr note --stack <name> --scope stack "<one sentence>"`; add\n' +
      '`--operations "METHOD /path"` for a restricted set. Read `show --stack <name>`\n' +
      'and reuse the same alongside/supersedes and evidence rules. Keep the source,\n' +
      'date and applicable version in the wording; stack scope is not verification.\n' +
      'Do not commit credential-specific account facts as stack-wide truth.\n', '')
    .replace("Prefer `api_context` and `api_context_record` only when each is listed in the\n" +
      "current session's tools. A repository registration or graph manifest does not\n" +
      "prove that a tool is loaded.\n" +
      "If either tool is absent, use the installed CLI from the repository root for\n" +
      "that operation. You do not need to restart before\n",
    "If `api_context` or `api_context_record` is not available in this session, use\n" +
      "the installed CLI from the repository root. You do not need to restart before\n")
    .replace("If `api_context_record` is listed in the current session's tools, prefer the\n" +
      "successful local `context_capture` receipt when recording a lesson from that request:\n",
    "If the repo exposes `api_context_record`, prefer the successful local\n" +
      "`context_capture` receipt when recording a lesson from that request:\n");
  const start = current.indexOf('\nNever edit the knowledge JSON by hand.');
  const end = current.indexOf('\nStructure, so every write reads the same three years on:', start);
  assert.ok(start >= 0 && end > start);
  const oldSource = join(root, 'previous-alpha8', 'SKILL.md');
  write(oldSource, current.slice(0, start) + current.slice(end));
  assert.equal(createHash('sha256').update(renderSkill(oldSource, PRODUCT)).digest('hex'),
    'a1b18645fee0a636a3f52b827794b5739ef383c5459fd9cdfacb439ca128323f');
  const previous = renderSkill(oldSource, `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.8`);
  const canonical = join(root, LAYOUT.skills, SKILL_NAMES.write, 'SKILL.md');
  const codex = join(root, '.agents/skills', SKILL_NAMES.write, 'SKILL.md');
  const claude = join(root, '.claude/skills', SKILL_NAMES.write, 'SKILL.md');
  for (const path of [canonical, codex]) write(path, previous);
  const edited = previous + '\nTeam instruction: a service owner must review corrections.\n';
  write(claude, edited);
  const upgrade = run(['connect', '--json']);
  const rows = upgrade.skills.filter(row => row.name === SKILL_NAMES.write);
  assert.equal(rows.find(row => row.host === 'project').action, 'updated');
  assert.equal(rows.find(row => row.host === 'codex').action, 'updated');
  assert.equal(rows.find(row => row.host === 'claude-code').action, 'differs');
  assert.match(readFileSync(canonical, 'utf8'), /Never edit the knowledge JSON by hand/);
  assert.match(readFileSync(codex, 'utf8'), /--supersedes sha256:<full-note-digest>/);
  assert.equal(readFileSync(claude, 'utf8'), edited);
  assert.equal(upgrade.setup.api.state, 'not_checked');
  assert.equal(upgrade.setup.context.verified, 0);
});


// The source fixture is frozen from published alpha.10 commit
// c23c2f56cc733f9bc1eb99f440f4c23bfd97c504. Its exact rendered policies are
// pinned below, so future prose changes cannot silently redefine the control.
test('connect upgrades published alpha.10 write guidance and preserves authored edits', t => {
  const { root, run } = fixture(t), source = SKILL_SOURCES[1];
  const oldSource = join(ROOT, 'test/fixtures/write-context-alpha10.txt');
  const digest = invocation => shippedSkillDigest(source, renderSkill(oldSource, invocation));
  assert.equal(digest(PRODUCT), '5ae1318dd8189ac41f014ef145d23e0061bf524ec7a81a66427a7d45cba248bc');
  assert.equal(digest(null), '765c36fa137204ea7ca8bcec695b72937c771a4e1ae37ad8da2cb62b4402181b');
  const codex = join(root, '.agents/skills', SKILL_NAMES.write, 'SKILL.md');
  for (const invocation of [PRODUCT, `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.10`, "node '/old install/bin/cli.mjs'", null]) {
    const previous = renderSkill(oldSource, invocation);
    write(codex, previous);
    assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'updated');
    assert.equal(planSkillRemoval(root, [source]).find(row => row.host === 'codex').action, 'removed');
    write(codex, previous + '\nTeam instruction: preserve source-owner attribution.\n');
    assert.equal(planSkills(root, { sources: [source] }).find(row => row.host === 'codex').action, 'differs');
    assert.equal(planSkillRemoval(root, [source]).find(row => row.host === 'codex').action, 'left');
  }
  const previous = renderSkill(oldSource, `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.10`);
  const canonical = join(root, LAYOUT.skills, SKILL_NAMES.write, 'SKILL.md');
  const claude = join(root, '.claude/skills', SKILL_NAMES.write, 'SKILL.md');
  for (const path of [canonical, codex]) write(path, previous);
  const edited = previous + '\nTeam instruction: a service owner must review corrections.\n';
  write(claude, edited);
  const upgrade = run(['connect', '--json']);
  const rows = upgrade.skills.filter(row => row.name === SKILL_NAMES.write);
  assert.equal(rows.find(row => row.host === 'project').action, 'updated');
  assert.equal(rows.find(row => row.host === 'codex').action, 'updated');
  assert.equal(rows.find(row => row.host === 'claude-code').action, 'differs');
  for (const path of [canonical, codex]) assert.match(readFileSync(path, 'utf8'), /record it once/);
  assert.equal(readFileSync(claude, 'utf8'), edited);
  assert.equal(upgrade.setup.api.state, 'not_checked');
  assert.equal(upgrade.setup.context.verified, 0);
});
