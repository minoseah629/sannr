import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { v: 1, repository: { id: 'acme/web', name: 'Web' }, nodes: [],
    dependencies: [{ from: 'repo', to: 'acme/billing#api', kind: 'calls' }],
    context: { providers: [{ node: 'acme/billing#api', provider: 'billing', environment: 'staging', protocol: 'http' }] } };
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify(manifest));
  const guard = join(root, 'no-network.mjs');
  writeFileSync(guard, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const denied=()=>{throw new Error('NETWORK_OR_PROCESS_FORBIDDEN');}; globalThis.fetch=denied;
    for(const module of [http,https,net,tls,child]) for(const name of ['request','get','connect','createConnection','createServer','spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) if(typeof module[name]==='function') module[name]=denied; syncBuiltinESMExports();`);
  const run = args => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, API_CONTEXT_OFF: '', NO_COLOR: '1', TERM: 'dumb', NODE_OPTIONS: `--import=${guard}`,
      SANNR_HOME: join(root, 'home'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_EVIDENCE: join(root, 'evidence') } });
  return { root, run };
}
function success(result) { assert.equal(result.status, 0, result.stdout + result.stderr + result.error); }
const recordArgs = ['graph', 'record', 'acme/billing#api', '--operation', 'POST /invoices', '--note', 'account_id is required despite the contract.', '--json'];

test('CLI captures, exports and retrieves the same authored API lesson with no network or process execution', t => {
  const { root, run } = fixture(t);
  const captured = run(recordArgs); success(captured); assert.equal(JSON.parse(captured.stdout).verification, 'external-claim');
  const exported = run(['graph', 'export', '--json']); success(exported);
  const receipt = JSON.parse(exported.stdout); assert.equal(receipt.knowledge, 1); assert.equal(receipt.published, false);
  const snapshot = JSON.parse(readFileSync(receipt.path, 'utf8')); assert.equal(snapshot.repository.id, 'acme/web');
  const queried = run(['graph', 'context', 'acme/billing#api', '--operation', 'POST /invoices', '--json']); success(queried);
  const delivered = JSON.parse(queried.stdout);
  assert.equal(delivered.knowledge[0]?.publisher, 'acme/web');
  assert.equal(delivered.knowledge[0].basis, 'authored');
  assert.equal(delivered.knowledge[0].verification, 'external-claim');
  assert.equal(delivered.omitted_foreign_claims ?? 0, 0);
  const text = run(['graph', 'context', 'acme/billing#api']); success(text);
  assert.match(text.stdout, /account_id is required/);
  const compactText = run(['graph', 'context', 'acme/billing#api', '--max-bytes', '2000']); success(compactText);
  assert.match(compactText.stdout, /account_id is required/);
  const impact = run(['graph', 'impact', 'acme/billing#api', '--json']); success(impact);
  const impacted = JSON.parse(impact.stdout);
  assert.equal(impacted.paths[0].node, 'acme/web#repo');
  assert.equal(impacted.knowledge[0]?.publisher, 'acme/web');
  assert.equal(impacted.knowledge[0].basis, 'authored');
  assert.equal(impacted.knowledge[0].verification, 'external-claim');
  assert.equal(receipt.path, join(root, LAYOUT.graphSnapshot));
});

test('catalog overrides read a portable file and report unknown nodes as nonzero JSON', t => {
  const { run } = fixture(t);
  success(run(recordArgs)); success(run(['graph', 'export']));
  success(run(['graph', 'context', 'acme/billing#api', '--catalog', LAYOUT.graphSnapshot, '--json']));
  const bad = run(['graph', 'context', 'missing#node', '--json']);
  assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.equal(JSON.parse(bad.stdout).issues[0].code, 'GRAPH_NODE_NOT_FOUND');
});

test('map supports a graph-only frontend and keeps declared dependencies separate from local scanned edges', t => {
  const { root, run } = fixture(t);
  const json = run(['map', '.', '--no-execute', '--json']); success(json);
  const map = JSON.parse(json.stdout); assert.equal(map.services.length, 0); assert.equal(map.edges.length, 0);
  assert.equal(map.graph.edges.length, 1); assert.equal(map.graph.coverage, 'partial');
  const html = run(['map', '.', '--no-execute', '--no-preview']); success(html);
  assert.ok(readFileSync(join(root, LAYOUT.mapOutput), 'utf8').includes('shared-dependency-graph'));
});

test('map fails clearly for an unavailable explicitly configured catalog', t => {
  const { run } = fixture(t);
  const result = run(['map', '.', '--no-execute', '--catalog', 'missing.json', '--json']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /GRAPH_/);
});

test('unknown, missing and repeated graph arguments fail without silently broadening scope', t => {
  const { run } = fixture(t);
  for (const args of [ ['graph', 'impact'], ['graph', 'context', '--catalog'], ['graph', 'context', '--json=x'],
    ['graph', 'context', '--json', '--json'], ['graph', 'context', '--unknown'], ['graph', 'export', 'one', 'two'] ]) {
    const result = run(args); assert.notEqual(result.status, 0); assert.match(result.stderr, /GRAPH_ARGUMENT_INVALID/);
  }
});

test('local stats do not claim behavior or savings when metrics are absent', t => {
  const { run } = fixture(t), result = run(['graph', 'stats', '--json']); success(result);
  const stats = JSON.parse(result.stdout); assert.equal(stats.recorded_events, 0); assert.match(stats.meaning, /do not prove/);
});
