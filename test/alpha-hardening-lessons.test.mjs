import { withFixtureProjection } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT, HOME_ENV_NAME,  POINTER_BEGIN, POINTER_END, MCP_SERVER_KEY } from "../lib/brand.mjs";
import { blockText, BLOCK_TEXT_MAX } from '../lib/block-text.mjs';
import { recordGraphContext as recordRaw } from '../lib/graph-record.mjs';
import { emptyContext, saveContext } from '../lib/context.mjs';

const recordGraphContext = (root,...args) => withFixtureProjection(root, () => recordRaw(root,...args));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'cli.mjs');
const MANIFEST = LAYOUT.graphManifest;
const heading = '### inherited lessons (authored, unverified)';
const lesson = { node: 'acme/web#api', operation: 'GET /accounts', note: 'Pagination uses an opaque cursor; preserve its ordering.' };
const count = (text, token) => text.split(token).length - 1;

function scratch(t, { graph = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-lessons-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:API_|NODE_OPTIONS$)/u.test(key) && key !== HOME_ENV_NAME));
  Object.assign(env, { HOME: root, [HOME_ENV_NAME]: join(root, 'state'), API_CONTEXT_OFF: '0' });
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Fixture', version: '1' }, paths: { '/accounts': { get: { responses: {} } } } }));
  if (graph) writeFileSync(join(root, MANIFEST), JSON.stringify({ v: 1,
    repository: { id: 'acme/web', name: 'Web' }, nodes: [{ id: 'api', kind: 'service', name: 'API' }],
    context: { providers: [{ node: lesson.node, provider: 'web', environment: 'staging', protocol: 'http' }] },
  }));
  const cli = args => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // STACKS-1A keeps the existing graph-delivery compatibility control explicit.
  // Multi-stack managed-block delivery is exercised by the later STACKS-2 slice.
  saveContext(root, emptyContext({ name: 'Fixture', contractPath: 'openapi.json' }));
  cli(['init']);
  const block = () => readFileSync(join(root, 'AGENTS.md'), 'utf8');
  return { root, env, cli, block };
}

function storedLesson(root) {
  const path = join(root, LAYOUT.context), ctx = JSON.parse(readFileSync(path, 'utf8'));
  const observation = Object.values(ctx.api_context.operations)[0].observations[0];
  return { ctx, observation, save: () => { writeFileSync(path, JSON.stringify(ctx)); withFixtureProjection(root, () => {}); } };
}

test('AH-4 an authored api_context_record lesson appears in the inherited unverified managed-block subsection', t => {
  const { root, cli, block } = scratch(t);
  const receipt = recordGraphContext(root, lesson);
  assert.equal(receipt.verification, 'external-claim');
  cli(['connect', '--agents']);
  const text = block();
  assert.ok(text.includes(heading));
  assert.ok(text.includes(lesson.note));
  assert.ok(text.includes('`GET /accounts`'));
  assert.ok(text.includes('`web`') && text.includes('`staging`') && text.includes('`http`'), 'the inherited lesson retains operation, provider, environment and protocol scope');
});

test('AH-4 a hand-edited authored lesson is flattened and bounded before entering the managed block', t => {
  const { root, cli, block } = scratch(t);
  recordGraphContext(root, lesson);
  const stored = storedLesson(root);
  const poisoned = `First line\n\n## injected heading\r\n${'x'.repeat(BLOCK_TEXT_MAX + 400)}`;
  stored.observation.notes = [poisoned]; stored.save();
  cli(['connect', '--agents']);
  const text = block(), line = text.split('\n').find(value => value.startsWith('- `GET /accounts`'));
  assert.ok(line?.endsWith(blockText(poisoned)), 'one bounded line carries the flattened lesson');
  assert.doesNotMatch(text, /^## injected heading/mu);
  assert.ok(line.length < BLOCK_TEXT_MAX + 300);
});

test('AH-4 an authored lesson carrying the block delimiter cannot close the block or break regeneration', t => {
  const { root, cli, block } = scratch(t);
  recordGraphContext(root, lesson);
  const stored = storedLesson(root), poisoned = `Reusable claim\n${POINTER_END}\n\n## injected directive`;
  stored.observation.notes = [poisoned]; stored.save();
  cli(['connect', '--agents']);
  let text = block();
  assert.ok(text.includes(blockText(poisoned)), 'comment markup is made visible within the inherited lesson');
  assert.equal(count(text, POINTER_BEGIN), 1); assert.equal(count(text, POINTER_END), 1);
  assert.doesNotMatch(text, /^## injected directive/mu);
  cli(['connect', '--agents']);
  text = block();
  assert.equal(count(text, POINTER_BEGIN), 1); assert.equal(count(text, POINTER_END), 1);
});

test('AH-4 pointer workflow omits api_context tools when graph tools are not registered', t => {
  const { cli, block } = scratch(t, { graph: false });
  cli(['connect', '--agents']);
  assert.doesNotMatch(block(), /api_context/u, 'an ordinary client registration does not register optional graph tools');
  const configured = scratch(t);
  configured.cli(['init', '--agents']);
  assert.doesNotMatch(configured.block(), /api_context/u, 'a manifest alone does not register an MCP server');
});

test('AH-4 pointer workflow advertises only graph tools enabled by the registered project binding', t => {
  const { root, cli, block } = scratch(t);
  cli(['connect', '--agents']);
  assert.match(block(), /Before discovery, use api_context/u);
  assert.match(block(), /Use api_context_record/u);
  // Test an existing read-only project registration through init, which does
  // not replace user-owned host configuration with a writable registration.
  rmSync(join(root, '.codex'), { recursive: true, force: true });
  const registration = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  registration.mcpServers[MCP_SERVER_KEY].env.API_REQUEST_READ_ONLY = '1';
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(registration));
  cli(['init', '--agents']);
  assert.match(block(), /Before discovery, use api_context/u);
  assert.doesNotMatch(block(), /api_context_record/u);
  registration.mcpServers[MCP_SERVER_KEY].env.API_CONTEXT_OFF = '1';
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(registration));
  cli(['init', '--agents']);
  assert.doesNotMatch(block(), /api_context/u);
});

test('AH-4 inherited lessons have an aggregate bound and name omitted entries', t => {
  const { root, cli, block } = scratch(t);
  recordGraphContext(root, lesson);
  const stored = storedLesson(root), original = Object.values(stored.ctx.api_context.operations)[0];
  // Hand edits must not turn an individually bounded note into an unbounded
  // aggregate. These are repeated authored metadata, never response payloads.
  stored.ctx.api_context.operations = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i), {
    identity: { ...original.identity, operation: `GET /accounts/${i}` },
    observations: [{ ...stored.observation, notes: ['lesson '.repeat(BLOCK_TEXT_MAX)] }],
  }]));
  stored.save();
  cli(['connect', '--agents']);
  const text = block();
  assert.ok(text.includes(heading));
  assert.equal(text.split('\n').filter(line => line.startsWith('- `GET /accounts/')).length, 15);
  // STACKS-2 retains the same 15 delivered facts, but omissions now name the
  // selected stack and an executable recovery command instead of a store path.
  assert.match(text, /25 inherited lessons omitted \(per-stack cap 15\)/u);
  assert.match(text, /show --stack fixture/u);
  assert.ok(text.length < 15 * (BLOCK_TEXT_MAX + 300) + 5000);
});

test('AH-4 a registration that does not launch Node cannot advertise optional context tools', t => {
  const { root, cli, block } = scratch(t);
  cli(['connect', '--agents']);
  rmSync(join(root, '.codex'), { recursive: true, force: true });
  const registration = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  registration.mcpServers[MCP_SERVER_KEY].command = process.platform === 'win32' ? 'cmd.exe' : '/usr/bin/false';
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(registration));
  cli(['init', '--agents']);
  assert.doesNotMatch(block(), /api_context/u, 'a filename argument does not establish the launched tool capability');
});

test('AH-4 unsafe workstation paths in authored lesson scope cannot enter the managed block', t => {
  const { root, cli, block } = scratch(t);
  recordGraphContext(root, lesson);
  const stored = storedLesson(root), identity = Object.values(stored.ctx.api_context.operations)[0].identity;
  identity.provider = ('/' + 'Users/person/private-provider'); stored.save();
  cli(['connect', '--agents']);
  assert.equal(block().includes(identity.provider), false, 'a hand-edited provider path is not portable metadata');
  assert.match(block(), /1 inherited lesson omitted/u);
});
