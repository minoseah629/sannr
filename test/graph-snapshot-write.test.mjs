import { captureGraphStackFixture, recordGraphStackFixture, prepareGraphStackFixture } from './helpers/graph-stack-fixture.mjs';
import { fixtureContextFile, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync,  readFileSync, mkdirSync, existsSync, symlinkSync, linkSync, readdirSync, lstatSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createMcpSession } from '../lib/mcp-transport.mjs';
import { fileURLToPath } from 'node:url';
import { recordGraphContext } from '../lib/graph-record.mjs';
import { graphContext } from '../lib/agent-graph-context.mjs';
import { exportGraphSnapshot } from '../lib/graph-export.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function setup(t, snapshot = 'share/catalog.json') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-snapshot-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { v: 1, repository: { id: 'fixture/web', name: 'Web' }, nodes: [],
    dependencies: [{ from: 'repo', to: 'fixture/api#service', kind: 'calls' }], context: {
      ...(snapshot ? { snapshot } : {}), providers: [{ node: 'fixture/api#service', provider: 'https://api.example.test', environment: 'test', protocol: 'http' }],
    } };
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify(manifest));
  return { root, manifest, target: join(root, 'share/catalog.json') };
}
const args = note => ({ node: 'fixture/api#service', operation: 'POST /widgets', environment: 'test', protocol: 'http', note });

test('a scoped lesson preserves the existing repository snapshot until stack export is supported', t => {
  const { root, target } = setup(t);
  writeFileSync(target, `${JSON.stringify(exportGraphSnapshot(root), null, 2)}\n`);
  const before = readFileSync(target);
  prepareGraphStackFixture(root);
  const result = recordGraphContext(root, args('A current stack lesson with no remote publication.'));
  assert.equal(result.state, 'captured');
  assert.equal(result.identity.stack, 'fixture');
  assert.equal(result.snapshot.state, 'deferred');
  assert.equal(result.snapshot.code, 'STACK_GRAPH_EXPORT_DEFERRED');
  assert.equal(result.snapshot.record_included, false);
  assert.equal(result.snapshot.lesson_saved, true);
  assert.equal(result.published, false);
  assert.equal(result.requests_executed, 0);
  assert.deepEqual(readFileSync(target), before);
  assert.equal(Object.values(read(fixtureContextFile(root)).api_context.operations)[0].observations.length, 1);
  assert.equal(existsSync(join(root, LAYOUT.context)), false, 'a live stack write creates no legacy projection');
});

test('recording materializes a configured snapshot for a fresh repository without an export command or API call', async t => {
  const { root, target } = setup(t);
  const result = recordGraphContext(root, args('Owner review was reported as a precondition; no request has verified this claim.'));
  assert.equal(result.snapshot.state, 'written'); assert.equal(result.snapshot.record_included, true);
  assert.equal(result.published, false); assert.equal(result.snapshot.published, false); assert.equal(result.requests_executed, 0);
  const snapshot = read(target);
  const claim = snapshot.knowledge.find(r => r.basis === 'authored');
  assert.equal(claim.verification, 'external-claim');
  assert.equal(claim.notes[0], 'Owner review was reported as a precondition; no request has verified this claim.');
  const next = setup(t, null);
  next.manifest.repository = { id: 'fixture/next', name: 'Next' }; next.manifest.catalog = 'catalog';
  writeFileSync(join(next.root, LAYOUT.graphManifest), JSON.stringify(next.manifest));
  mkdirSync(join(next.root, 'catalog')); writeFileSync(join(next.root, 'catalog/web.json'), readFileSync(target));
  const inherited = await graphContext(next.root, { action: 'context', operation: 'POST /widgets', environment: 'test', include_foreign_claims: true });
  assert.equal(inherited.knowledge.length, 0, 'a writer cannot populate its provider\'s ordinary knowledge section');
  const delivered = inherited.foreign_claims.find(r => r.notes.includes(claim.notes[0]));
  assert.ok(delivered);
  assert.equal(delivered.publisher, 'fixture/web');
  assert.equal(delivered.verification, 'external-claim');
  assert.equal(inherited.requests_executed, 0);
});

test('observation-linked lessons refresh the artifact and keep original evidence lineage without copying payloads', t => {
  const { root, target } = setup(t);
  prepareGraphStackFixture(root); writeFileSync(join(root, fixtureEvidencePath(), 'run.json'), '{"private":"fixture-payload"}');
  const source = captureGraphStackFixture(root, { identity: { provider: 'https://api.example.test', environment: 'test', protocol: 'http', operation: 'POST /widgets' },
    source: { tool: 'api_request' }, basis: 'observed', outcome: 'success', complete: true,
    observed_at: '2020-01-01T00:00:00Z', response: { state: 'draft' }, evidence: [{ path: `${fixtureEvidencePath()}/run.json` }] }, { internal: true });
  const first = recordGraphStackFixture(root, { observation_id: source.observation_id, note: 'A dated observation; current applicability is unknown.' });
  const before = readFileSync(target);
  const second = recordGraphStackFixture(root, args('Another attributed claim without execution.'));
  assert.equal(first.scoped_snapshot.code, 'STACK_GRAPH_EXPORT_DEFERRED');
  assert.equal(first.snapshot.state, 'written'); assert.equal(second.snapshot.state, 'written');
  assert.notDeepEqual(readFileSync(target), before);
  const linked = read(target).knowledge.find(r => r.based_on);
  assert.equal(linked.based_on.observation_id, source.observation_id);
  assert.equal(linked.observed_at, '2020-01-01T00:00:00.000Z');
  assert.equal(linked.evidence[0].state, 'unavailable');
  assert.doesNotMatch(readFileSync(target, 'utf8'), /fixture-payload/);
  assert.deepEqual(readdirSync(dirname(target)), ['catalog.json']);
});

test('absent configuration keeps the legacy local capture behavior', t => {
  const { root, target } = setup(t, null);
  const result = recordGraphContext(root, args('Unverified team claim.'));
  assert.equal(result.snapshot, undefined); assert.equal(existsSync(target), false);
});

test('foreign files and publishers remain untouched after the lesson is saved', t => {
  for (const kind of ['foreign-file', 'foreign-publisher']) {
    const { root, target } = setup(t);
    mkdirSync(dirname(target));
    const other = join(root, 'protected.json'); writeFileSync(other, '{"keep":"untouched"}');
    if (kind === 'foreign-file') writeFileSync(target, '{"keep":"untouched"}');
    if (kind === 'foreign-publisher') {
      const foreign = setup(t, null); foreign.manifest.repository = { id: 'fixture/foreign', name: 'Foreign' };
      writeFileSync(join(foreign.root, LAYOUT.graphManifest), JSON.stringify(foreign.manifest));
      writeFileSync(target, JSON.stringify(exportGraphSnapshot(foreign.root)));
    }
    const before = existsSync(target) ? readFileSync(target) : null;
    const result = recordGraphContext(root, args(`Unverified claim for ${kind}.`));
    assert.equal(result.state, 'captured'); assert.equal(result.snapshot.state, 'failed', kind);
    assert.equal(result.snapshot.lesson_saved, true); assert.equal(result.published, false);
    if (before) assert.deepEqual(readFileSync(target), before);
    assert.equal(readFileSync(other, 'utf8'), '{"keep":"untouched"}');
    assert.match(result.next, /do not record the lesson again/);
  }
});

// A valid snapshot from this same publisher passes content and ownership checks.
// Invalid foreign JSON would still refuse if every link guard were removed,
// masking the exact filesystem boundary these specimens are meant to protect.
for (const kind of ['symlink', 'hardlink', 'directory-link']) {
  test(`AH-6 snapshot writer refuses a ${kind} to a valid same-publisher snapshot`, t => {
    const { root, target } = setup(t);
    const other = join(root, 'protected.json');
    const bytes = `${JSON.stringify(exportGraphSnapshot(root), null, 2)}\n`;
    writeFileSync(other, bytes);
    mkdirSync(dirname(target));
    if (kind === 'symlink') symlinkSync(other, target);
    if (kind === 'hardlink') linkSync(other, target);
    if (kind === 'directory-link') {
      rmSync(dirname(target), { recursive: true });
      const protectedDirectory = join(root, 'protected-dir');
      mkdirSync(protectedDirectory);
      writeFileSync(join(protectedDirectory, 'catalog.json'), bytes);
      symlinkSync(protectedDirectory, dirname(target), 'dir');
    }
    const identity = lstatSync(target);
    const result = recordGraphContext(root, args('An unverified claim must not replace a linked destination.'));
    assert.equal(result.state, 'captured');
    assert.equal(result.snapshot.state, 'failed', `${kind} must refuse even when publisher and snapshot bytes are valid`);
    assert.equal(result.snapshot.code, 'GRAPH_SNAPSHOT_DESTINATION_REFUSED');
    assert.equal(result.snapshot.lesson_saved, true);
    assert.equal(result.published, false);
    assert.equal(lstatSync(target).ino, identity.ino, 'the linked directory entry must not be replaced');
    assert.equal(lstatSync(target).isSymbolicLink(), identity.isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), bytes);
    assert.equal(readFileSync(other, 'utf8'), bytes);
  });
}

test('concurrent processes retain every lesson and leave a current complete snapshot', async t => {
  const { root, target } = setup(t);
  prepareGraphStackFixture(root);
  const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {recordGraphStackFixture} from ${JSON.stringify(new URL('./helpers/graph-stack-fixture.mjs', import.meta.url).href)};const r=recordGraphStackFixture(${JSON.stringify(root)},${JSON.stringify(args(`Concurrent claim ${i}; unverified.`))});if(r.snapshot.state!=='written')process.exit(1);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', bytes => { error += bytes; }); child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(error || `exit ${code}`)));
  }));
  await Promise.all(runs);
  assert.equal(read(target).knowledge.filter(r => r.basis === 'authored').length, 6);
  const currentDigest = read(target).knowledge[0].source.digest;
  assert.ok(read(target).knowledge.every(r => r.source.digest === currentDigest));
  assert.deepEqual(readdirSync(dirname(target)), ['catalog.json']);
});


test('export bounds explicitly report a saved lesson omitted from the snapshot', t => {
  const { root, manifest, target } = setup(t);
  manifest.context.legacy = 'repo';
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify(manifest));
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0, operations:
    Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`GET /legacy/${i}`, {}])) }));
  const result = recordGraphStackFixture(root, args('The bounded export cannot carry this authored lesson.'));
  assert.equal(result.state, 'captured'); assert.equal(result.snapshot.state, 'limited');
  assert.equal(result.snapshot.record_included, false); assert.equal(result.published, false);
  assert.match(result.next, /omitted this lesson/);
  assert.equal(read(target).knowledge.length, 2000);
  assert.ok(read(target).omissions.some(text => /export bound/.test(text)));
  assert.equal(Object.values(read(join(root, LAYOUT.context)).api_context.operations)[0].observations.length, 1);
});

test('MCP and CLI expose partial sharing failure while preserving one local lesson and the foreign destination', async t => {
  const { root, target } = setup(t);
  mkdirSync(dirname(target)); writeFileSync(target, '{"keep":"foreign"}');
  const guard = join(root, 'no-execution.mjs'), marker = join(root, 'execution-attempted');
  writeFileSync(guard, `
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
    import child from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const refused = () => { writeFileSync(${JSON.stringify(marker)}, 'attempted'); throw new Error('No execution allowed'); };
    globalThis.fetch = refused;
    for (const module of [http, https, net, tls]) for (const name of ['request','get','connect','createConnection','createServer']) if (typeof module[name] === 'function') module[name] = refused;
    for (const name of ['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync']) child[name] = refused;
    syncBuiltinESMExports();
  `);
  const env = Object.fromEntries(Object.keys(process.env).filter(key => /^(?:API_|SANNR_|NODE_OPTIONS)/u.test(key)).map(key => [key, undefined]));
  Object.assign(env, { API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', SANNR_HOME: join(root, 'home'), NODE_OPTIONS: `--import=${guard}` });
  const session = createMcpSession({ command: process.execPath, args: [fileURLToPath(new URL('../server.mjs', import.meta.url))], cwd: root, env, timeoutMs: 5000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'snapshot-partial-qa', version: '1' } });
  const reply = await session.request('tools/call', { name: 'api_context_record', arguments: args('One authored MCP lesson; no API proof.') });
  assert.equal(reply.result.isError, true);
  const result = JSON.parse(reply.result.content[0].text);
  assert.equal(result.state, 'captured'); assert.equal(result.snapshot.state, 'failed');
  assert.equal(result.snapshot.lesson_saved, true); assert.equal(result.requests_executed, 0);
  assert.match(result.next, /do not record the lesson again/);
  assert.equal(Object.values(read(join(root, LAYOUT.context)).api_context.operations)[0].observations.length, 1);
  assert.equal(existsSync(marker), false, 'MCP capture/export executes no requests, listeners or child processes');
  // CLI startup may read local Git metadata. Keep the network guard active.
  const networkGuard = join(root, 'no-network.mjs');
  writeFileSync(networkGuard, readFileSync(guard, 'utf8').replace(/    for \(const name of \['spawn'.*child\[name\] = refused;/u, ''));
  // A separate fixture verifies CLI delivery without retrying the MCP lesson.
  const cli = setup(t); mkdirSync(dirname(cli.target)); writeFileSync(cli.target, '{"keep":"foreign"}');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/cli.mjs', import.meta.url)), 'graph', 'record',
    'fixture/api#service', '--operation', 'POST /widgets', '--environment', 'test', '--note', 'One authored CLI lesson; no API proof.', '--json'],
    { cwd: cli.root, env: { ...process.env, ...env, API_CONTEXT_DIR: cli.root, NODE_OPTIONS: `--import=${networkGuard}` }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(JSON.parse(child.stdout).snapshot.state, 'failed');
  assert.equal(Object.values(read(join(cli.root, LAYOUT.context)).api_context.operations)[0].observations.length, 1);
  for (const destination of [target, cli.target]) assert.equal(readFileSync(destination, 'utf8'), '{"keep":"foreign"}');
  assert.equal(existsSync(marker), false, 'local recording/export never executes an API request or listener');
});
