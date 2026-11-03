// Synthetic authored facts: no API traffic or private payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile, inFixtureStack } from './helpers/stack-fixture.mjs';
import { recordGraphContext, graphRecordTool } from '../lib/graph-record.mjs';
import { queryOperationContext } from '../lib/operation-context.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME, FEEDBACK_STACK_NAME } from '../lib/brand.mjs';
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const FACT = 'Documented: writes use the provider error code.';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-2a-surfaces-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture author'], { cwd: root });
  for (const name of ['alpha', 'bravo']) {
    createFixtureStack(root, { name, baseUrl: `https://${name}.example.test` });
    writeFileSync(fixtureContextFile(root, name), JSON.stringify({ v: 0, api: { name }, operations: {} }));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(API_|SANNR_)/.test(k)));
  Object.assign(env, { HOME: root, [HOME_ENV_NAME]: root, API_REPO_ROOT: root, API_CONTEXT_DIR: root, NO_COLOR: '1' });
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  const json = (...args) => { const r = cli(...args); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  const note = (text, ...args) => json('note', '--stack', 'alpha', '--scope', 'stack', text, ...args, '--json');
  return { root, cli, json, note, ctx: () => JSON.parse(readFileSync(fixtureContextFile(root, 'alpha'))) };
}
test('CONTEXT-2a CLI stack scope shares note relationships, evidence and show history', t => {
  const f = fixture(t), first = f.note(FACT, '--operations', 'POST /widgets', 'GET /widgets', '--evidence', 'run-missing');
  assert.deepEqual(first.key, { kind: 'stack' });
  assert.equal(first.evidence[0].state, 'unavailable');
  const refused = f.cli('note', '--stack', 'alpha', '--scope', 'stack', 'A correction.', '--json');
  assert.equal(refused.status, 3); assert.equal(JSON.parse(refused.stdout).refused, 'NOTE_RELATION_REQUIRED');
  const next = f.note('Observed: errors include a stable code.', '--supersedes', first.note_id);
  assert.deepEqual(next.evidence, []);
  const shown = f.json('show', '--stack', 'alpha');
  assert.equal(shown.stack_facts.active_notes[0], 'Observed: errors include a stable code.');
  assert.equal(shown.stack_facts.note_history.history[0].id, first.note_id);
  assert.equal(shown.stack_facts.note_history.history[0].provenance.operations.length, 2);
  const human = f.cli('show', '--stack', 'alpha', '--human', '--history');
  assert.equal(human.status, 0, human.stderr); assert.match(human.stdout, /Stack facts/); assert.match(human.stdout, /Superseded/);
});
test('CONTEXT-2a context query searches stack facts without crossing stacks', t => {
  const f = fixture(t); f.note(FACT);
  const file = join(f.root, 'query.json'); writeFileSync(file, JSON.stringify({ search: 'provider error' }));
  const found = f.json('context', 'query', file, '--stack', 'alpha');
  assert.equal(found.stack_facts.records[0].text, FACT);
  writeFileSync(file, JSON.stringify({ search: 'missing phrase' }));
  assert.equal(f.json('context', 'query', file, '--stack', 'alpha').stack_facts?.records.length ?? 0, 0);
  writeFileSync(file, '{}');
  assert.equal(f.json('context', 'query', file, '--stack', 'bravo').stack_facts?.records.length ?? 0, 0);
});
test('CONTEXT-2a doctor inspects stack history and review can acknowledge its baseline', t => {
  const f = fixture(t); f.note(FACT);
  const ctx = f.ctx(); ctx.stack_facts.notes[0] = 'Documented: a human edited this fact.';
  writeFileSync(fixtureContextFile(f.root, 'alpha'), JSON.stringify(ctx));
  const shown = f.json('show', '--stack', 'alpha'); assert.equal(shown.stack_facts.note_history.state, 'changed');
  const doctor = f.cli('doctor', '--stack', 'alpha', '--offline', '--json');
  assert.match(doctor.stdout + doctor.stderr, /NOTE_HISTORY_CHANGED/);
  const accepted = f.json('review', '--stack', 'alpha', '--scope', 'stack', '--accept-notes', '--if-notes', shown.stack_facts.note_history.digest);
  assert.equal(accepted.note_history.state, 'healthy');
});
test('CONTEXT-2a MCP record stack form uses the same history and preserves tool availability rules', t => {
  const f = fixture(t);
  assert.equal(graphRecordTool(f.root), null, 'no graph registration invented');
  mkdirSync(join(f.root, LAYOUT.graphManifest, '..'), { recursive: true });
  writeFileSync(join(f.root, LAYOUT.graphManifest), JSON.stringify({ v: 1, repository: { id: 'fixture/repo', name: 'Fixture' }, nodes: [], dependencies: [] }));
  const tool = graphRecordTool(f.root); assert.ok(tool.inputSchema.properties.scope);
  const first = recordGraphContext(f.root, { stack: 'alpha', scope: 'stack', note: FACT, operations: ['GET /widgets'] });
  assert.equal(first.requests_executed, 0); assert.deepEqual(first.key, { kind: 'stack' });
  assert.throws(() => recordGraphContext(f.root, { stack: 'alpha', scope: 'stack', note: 'Another fact.' }), { code: 'NOTE_RELATION_REQUIRED' });
  const next = recordGraphContext(f.root, { stack: 'alpha', scope: 'stack', note: 'A scoped correction.', supersedes: first.note_id });
  assert.ok(next.note_id); assert.equal(f.ctx().stack_facts.note_replacements.length, 1);
  assert.deepEqual(f.json('show', '--stack', 'bravo').operations, []);
});

test('CONTEXT-2a packaged feedback shares day-one facts and keeps endpoint rules scoped', t => {
  const f = fixture(t), shown = f.json('show', '--stack', FEEDBACK_STACK_NAME);
  assert.ok(shown.stack_facts.active_notes.some(note => /redirects/.test(note)));
  assert.ok(shown.stack_facts.active_notes.every(note => !/30 seconds|HTTP 202/.test(note)));
  const refused = f.cli('note', '--stack', FEEDBACK_STACK_NAME, '--scope', 'stack', FACT, '--json');
  assert.notEqual(refused.status, 0);
});

test('CONTEXT-2a query honors scope filters and its minimum byte bound', t => {
  const f = fixture(t), name = 'longstack'.repeat(7);
  createFixtureStack(f.root, { name });
  const first = f.note(FACT);
  writeFileSync(fixtureContextFile(f.root, name), JSON.stringify(f.ctx()));
  const bounded = inFixtureStack(f.root, () => queryOperationContext(f.root, {}, { maxBytes: 512 }), name);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 512);
  assert.match(bounded.stack_facts.show_command, new RegExp(name));
  assert.ok(bounded.stack_facts.omitted > 0);
  for (const query of [{ provider: 'https://other.example.test' }, { environment: 'other' }, { stack: 'other' }]) {
    const result = inFixtureStack(f.root, () => queryOperationContext(f.root, query), 'alpha');
    assert.equal(result.stack_facts, undefined);
  }
  const ctx = f.ctx(); ctx.stack_facts.notes_provenance[0].operations = 'invalid';
  writeFileSync(fixtureContextFile(f.root, 'alpha'), JSON.stringify(ctx));
  const human = f.cli('show', '--stack', 'alpha', '--human');
  assert.equal(human.status, 1); assert.doesNotMatch(human.stderr, /TypeError/);
  assert.match(human.stdout, /invalid scope/);
});
