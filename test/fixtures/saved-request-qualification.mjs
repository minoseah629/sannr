// Reproducible synthetic reader-compatibility and envelope-volume specimen.
// Usage: node ... --alpha-package DIR --baseline-package DIR --output FILE
// Optional: --current-package DIR (defaults to this checkout), --current-tarball FILE
// Packages are prepared independently; this script downloads nothing.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, args) => index % 2 ? pairs : [...pairs, [item, args[index + 1]]], []));
if (!options['--alpha-package'] || !options['--baseline-package'] || !options['--output']) throw new Error('Provide the two extracted package directories and output file.');
const currentPackage = options['--current-package'] ? resolve(options['--current-package']) : fileURLToPath(new URL('../../', import.meta.url));
const currentBuild = options['--current-package'] ? 'workbench-selected-package' : 'workbench-working-tree';
// Fixture writes and measured execution both use the selected candidate. Never
// qualify an installed reader using a silently newer source-tree writer.
const { LAYOUT } = await import(pathToFileURL(join(currentPackage, 'lib/layout.mjs')).href);
const { HOME_ENV_NAME } = await import(pathToFileURL(join(currentPackage, 'lib/brand.mjs')).href);
const { saveSavedRequest } = await import(pathToFileURL(join(currentPackage, 'lib/saved-requests.mjs')).href);
const packageJson = JSON.parse(readFileSync(join(currentPackage, 'package.json')));
const currentIdentity = { mode: options['--current-package'] ? 'selected-package' : 'working-tree', package_name: packageJson.name, package_version: packageJson.version,
  ...(existsSync(join(currentPackage, 'lib/build-info.json')) ? { build_id: JSON.parse(readFileSync(join(currentPackage, 'lib/build-info.json'))).buildId } : {}),
  file_sha256: Object.fromEntries(['package.json', 'lib/client.mjs', 'lib/saved-requests.mjs'].map(file => [file, createHash('sha256').update(readFileSync(join(currentPackage, file))).digest('hex')])),
  ...(options['--current-tarball'] ? { tarball_sha256: createHash('sha256').update(readFileSync(options['--current-tarball'])).digest('hex') } : {}) };
const root = mkdtempSync(join(tmpdir(), 'saved-qualification-'));
let traffic = 0;
const server = createServer((req, res) => { traffic++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ready":true}'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
function fixture(label) {
  const dir = join(root, label), folder = join(dir, LAYOUT.collection, 'fixture');
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, 'openapi.json'), { openapi: '3.0.3', info: { title: 'Synthetic', version: '1' }, paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } });
  writeJson(join(folder, 'stack.json'), { v: 1, name: 'fixture', default_environment: 'local', contract: 'openapi.json', environments: { local: { baseUrl } } });
  mkdirSync(join(dir, 'home')); mkdirSync(join(dir, LAYOUT.evidence, 'fixture'), { recursive: true });
  return dir;
}
function child(packagePath, dir, task, { off = false } = {}) {
  const client = pathToFileURL(join(packagePath, 'lib/client.mjs')).href;
  const suites = pathToFileURL(join(packagePath, 'lib/suites.mjs')).href;
  const code = `import {readFileSync} from 'node:fs';const task=JSON.parse(readFileSync(0,'utf8'));const api=await import(${JSON.stringify(client)});if(task.kind==='compat'){const suites=await import(${JSON.stringify(suites)});const before=readFileSync(task.suiteFile,'utf8'),savedBefore=readFileSync(task.savedFile,'utf8');const loaded=suites.loadSuite(process.cwd(),'existing');const out={direct:await api.apiRequest(task.document),batch:await api.runEnvelope(task.document),v1:await api.runEnvelope({v:1,requests:[{method:'GET',path:'/health'}]}),suites:suites.listSuites(process.cwd()),existing_loaded:loaded?.suite?.requests?.length===1,existing_unchanged:before===readFileSync(task.suiteFile,'utf8'),saved_unchanged:savedBefore===readFileSync(task.savedFile,'utf8')};console.log(JSON.stringify(out));}else{const result=await api.apiRequest({method:'GET',path:'/health',stack:'fixture',environment:'local',capture_context:false});const serialized=JSON.stringify(result);console.log(JSON.stringify({status:result.status,assertions:result.assertions,bytes:Buffer.byteLength(serialized),envelope_tokens_estimate:api.tokens(serialized),saved_context:result.known?.saved_requests??null}));}`;
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: { PATH: process.env.PATH, HOME: join(dir, 'home'), [HOME_ENV_NAME]: join(dir, 'machine'), API_CONTEXT_DIR: dir, API_USAGE_LOG: join(dir, 'machine', 'usage.jsonl'), API_FRICTION_OFF: '1', API_BUDGET: '6000', ...(off ? { API_CONTEXT_OFF: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; processChild.stdout.on('data', data => stdout += data); processChild.stderr.on('data', data => stderr += data);
    processChild.once('error', reject); processChild.once('close', code => {
      if (code) reject(new Error(`Synthetic process failed (${code}): ${stderr.slice(0, 300)}`));
      else try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid synthetic process output.')); }
    });
    processChild.stdin.end(JSON.stringify(task));
  });
}
const draft = index => ({ name: `health-${index}`, folder: 'samples', stack: 'fixture', environment: 'local', request: { method: 'GET', path: '/health', bindings: {} }, inputs: {}, credentials: [] });
try {
  const compatibilityRoot = fixture('compatibility');
  const saved = saveSavedRequest(compatibilityRoot, draft(0));
  writeJson(join(compatibilityRoot, LAYOUT.suites, 'existing.json'), { v: 2, name: 'existing', requests: [{ method: 'GET', path: '/health', expect: [{ status: 200 }] }] });
  const beforeTraffic = traffic;
  const compatibility = await child(resolve(options['--alpha-package']), compatibilityRoot, { kind: 'compat', document: saved.document,
    suiteFile: join(compatibilityRoot, LAYOUT.suites, 'existing.json'), savedFile: join(compatibilityRoot, saved.path) });
  assert.equal(compatibility.direct.error.code, 'REQUEST_ROUTING_FIELD_UNSUPPORTED');
  assert.equal(compatibility.batch.error.code, 'REQUEST_ROUTING_FIELD_UNSUPPORTED');
  assert.equal(compatibility.v1.error.code, 'ENVELOPE_VERSION_UNSUPPORTED');
  assert.deepEqual(compatibility.suites.map(row => typeof row === 'string' ? row : row.name), ['existing']);
  assert.equal(compatibility.existing_loaded, true); assert.equal(compatibility.existing_unchanged, true); assert.equal(compatibility.saved_unchanged, true); assert.equal(traffic, beforeTraffic);
  const rows = [];
  for (const count of [0, 1, 10]) for (const off of [false, true]) for (const [build, packagePath] of [['baseline-main', resolve(options['--baseline-package'])], [currentBuild, currentPackage]]) {
    const dir = fixture(`${build}-${count}-${off}`);
    for (let index = 0; index < count; index++) saveSavedRequest(dir, { ...draft(index), id: `req-${randomUUID()}` });
    const observed = await child(packagePath, dir, { kind: 'cost' }, { off });
    assert.equal(observed.status, 200); assert.equal(observed.assertions, null);
    if (off || build === 'baseline-main' || !count) assert.equal(observed.saved_context, null);
    else { assert.equal(observed.saved_context.requests.length, Math.min(5, count)); assert.equal(observed.saved_context.omitted, Math.max(0, count - 5)); assert.equal(observed.saved_context.bytes, Buffer.byteLength(JSON.stringify(observed.saved_context))); }
    rows.push({ build, saved_requests: count, context_off: off, ...observed });
  }
  const report = { schema_version: 1, captured_at: new Date().toISOString(), node: process.version, baseline_commit: '830ee81c123afd3ad93af8dd4c35a15a4bc4b14e',
    alpha_version: JSON.parse(readFileSync(join(options['--alpha-package'], 'package.json'))).version,
    ...(options['--alpha-tarball'] ? { alpha_tarball_sha256: createHash('sha256').update(readFileSync(options['--alpha-tarball'])).digest('hex') } : {}),
    current_package: currentIdentity,
    alpha_compatibility: { direct_refusal: compatibility.direct.error.code, batch_refusal: compatibility.batch.error.code, explicit_v1_refusal: compatibility.v1.error.code,
      suites: compatibility.suites, existing_suite_loaded: true, existing_suite_bytes_unchanged: true, saved_request_bytes_unchanged: true, compatibility_traffic: 0 },
    measurements: rows, synthetic_requests: traffic,
    limits: ['One clean Node process per measured request; local fixture only.', 'UTF-8 serialized engine result bytes and engine length/4 token estimates; no host usage or whole-session price measurement.', 'No assertions in measured requests; same HTTP 200 synthetic result across cases.', 'Saved-request run metadata, CLI pretty-printing, MCP wrappers and standing tool schema are outside this direct-engine measurement.', options['--current-package'] ? 'Selected-package observation; no publication claim. A supplied tarball hash identifies the archive; install-to-archive byte equivalence is a separate packaging check.' : 'Working-tree observation, not an installed/published candidate claim.'] };
  writeJson(resolve(options['--output']), report); console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
}
