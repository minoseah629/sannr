import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {  HOME_ENV_NAME, MCP_SERVER_KEY, PRODUCT } from "../lib/brand.mjs";
import { emptyContext, saveContext } from '../lib/context.mjs';
import { planSetupContract } from '../lib/setup-contract.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

function fixture(t, existing = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-contract-integrity-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'consumer');
  mkdirSync(root);
  const foreign = join(parent, 'foreign-openapi.json');
  const foreignBytes = JSON.stringify({ openapi: '3.0.0', info: { title: 'Foreign fixture', version: '1' },
    paths: { '/foreign-only': { get: { responses: { 200: { description: 'OK' } } } } } });
  writeFileSync(foreign, foreignBytes);
  try { symlinkSync(foreign, join(root, 'openapi.json')); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Creating the refused-contract symlink requires Windows symlink privileges.');
      return null;
    }
    throw error;
  }
  const file = join(root, LAYOUT.environments);
  const configuration = JSON.stringify({ v: 1, default: 'local',
    environments: { local: { baseUrl: 'http://127.0.0.1:1' } } });
  writeFileSync(file, configuration);
  const contextFile = join(root, LAYOUT.context);
  if (existing) saveContext(root, emptyContext({ name: 'Consumer fixture', contractPath: null, contractDigest: null }));
  const contextBefore = existing ? readFileSync(contextFile, 'utf8') : null;
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('API_') && !key.startsWith(`${PRODUCT.toUpperCase()}_`)));
  Object.assign(env, { [HOME_ENV_NAME]: join(parent, 'state'), API_CONTEXT_OFF: '0',
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl') });
  const plan = planSetupContract(root, { file, name: 'local', baseUrlSource: 'config',
    baseUrl: 'http://127.0.0.1:1' }, { env });
  assert.equal(plan.contract, null, 'The binding must first refuse the out-of-project symlink target.');
  assert.match(plan.report.reason, /outside this project/);
  assert.equal(plan.file, undefined);
  return { root, env, file, configuration, contextFile, contextBefore, foreign, foreignBytes };
}

for (const [command, existing] of [['start', false], ['connect', true]]) {
  test(`AH-1: ${command} never records a symlinked contract refused by the setup binding${existing ? ' in existing context' : ''}`, t => {
    const f = fixture(t, existing);
    if (!f) return;
    const run = spawnSync(process.execPath, [CLI, command, '--json'], {
      cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    if (command === 'start') assert.equal(receipt.requests_executed, 0);
    assert.match((command === 'start' ? receipt.connection : receipt).contract_binding.reason, /outside this project/);
    assert.equal(readFileSync(f.file, 'utf8'), f.configuration, 'A refused contract cannot enter the environment record.');
    const registration = JSON.parse(readFileSync(join(f.root, '.mcp.json'), 'utf8'));
    assert.equal(registration.mcpServers[MCP_SERVER_KEY].env.API_CONTRACT, undefined,
      'A refused contract cannot enter the generated provider binding.');
    if (existing) assert.equal(readFileSync(f.contextFile, 'utf8'), f.contextBefore,
      'A refused contract cannot attach to or add operations to existing knowledge.');
    else assert.equal(existsSync(f.contextFile), false,
      'A refused contract cannot be rediscovered into a new knowledge record.');
    assert.equal(receipt.setup.context.operations, 0);
    assert.doesNotMatch(run.stdout, /Foreign fixture|foreign-only/);
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(f.root, name);
      if (existsSync(path)) assert.doesNotMatch(readFileSync(path, 'utf8'), /Foreign fixture|foreign-only/);
    }
    assert.equal(readFileSync(f.foreign, 'utf8'), f.foreignBytes);
  });
}
