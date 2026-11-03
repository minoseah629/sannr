// Engineering qualification of one exact local archive, not an ordinary unit
// suite. No development modules, team checkout, credentials or vendor traffic.
// Usage: node scripts/qualify-survey.mjs --package exact.tgz --out new-results
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!['--package', '--out'].includes(args[index]) || options.has(args[index]) || !args[index + 1]) {
    console.error('Usage: node scripts/qualify-survey.mjs --package exact.tgz --out new-results');
    process.exit(2);
  }
  options.set(args[index], args[index + 1]);
}
if (options.size !== 2) {
  console.error('Both --package and --out are required; the result directory must not exist.');
  process.exit(2);
}
const archive = resolve(options.get('--package')), output = resolve(options.get('--out'));
if (!existsSync(archive) || !lstatSync(archive).isFile() || !archive.endsWith('.tgz') || existsSync(output)) {
  console.error('The exact archive must be a regular .tgz file and --out must be a new directory.');
  process.exit(2);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const spec = (title, paths) => ({ openapi: '3.0.3', info: { title, version: '1' },
  paths: Object.fromEntries(paths.map(path => [path, { get: { responses: { 200: { description: 'Synthetic response' } } } }])) });
// Match process.cwd() spelling on systems whose temporary root is a symlink,
// so direct installed-module diagnostics use the same private baseline as CLI.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'survey-candidate-')));
const home = join(scratch, 'home'), install = join(scratch, 'install'), fixture = join(scratch, 'project');
for (const directory of [home, install, fixture, output]) mkdirSync(directory, { mode: 0o700 });
write(join(home, '.npmrc'), '');
write(join(install, 'package.json'), { name: 'survey-candidate-fixture', private: true });
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, CI: '1', NO_COLOR: '1',
  npm_config_cache: join(scratch, 'empty-cache'), npm_config_userconfig: join(home, '.npmrc'),
  npm_config_registry: 'http://127.0.0.1:1/', npm_config_offline: 'true',
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
const report = { v: 1, kind: 'survey-candidate-qualification', state: 'failed', captured_at: new Date().toISOString(),
  package_sha256: sha(readFileSync(archive)), qualifier_sha256: sha(readFileSync(new URL(import.meta.url))),
  node: process.version, platform: process.platform, arch: process.arch, steps: [], checks: [], artifacts: [],
  limits: ['Unpublished exact local archive; no vendor requests or application starts.',
    'Fresh isolated HOME; core-only offline install with lifecycle scripts and optional adapters disabled.',
    'The offline supplies specimen is a synthetic retained observation with unavailable private proof; not a fresh execution claim.',
    'Times and byte counts are diagnostics, not performance thresholds or general benchmarks.',
    'No browser rendering or local-repository coverage claim is made by this script.'] };
let server, phase = 'offline-install';
const check = name => report.checks.push({ name, state: 'passed' });
const cleanFailure = error => ({ phase, name: error?.name === 'AssertionError' ? 'AssertionError' : 'QualificationError',
  message: 'Qualification did not complete; inspect the named phase and private diagnostics. No partial pass is implied.' });
async function run(label, command, commandArgs, { cwd = fixture, extraEnv = {}, expected = 0 } = {}) {
  phase = label;
  const started = performance.now(), child = spawn(command, commandArgs,
    { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exceeded = false;
  for (const [stream, consume] of [[child.stdout, value => stdout += value], [child.stderr, value => stderr += value]]) {
    stream.setEncoding('utf8'); stream.on('data', chunk => {
      consume(chunk);
      if (stdout.length + stderr.length > 16 * 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); }
    });
  }
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
  let exit;
  try { exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); }); }
  finally { clearTimeout(timeout); }
  const measurement = { name: label, exit, duration_ms: Math.round((performance.now() - started) * 100) / 100,
    stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr) };
  report.steps.push(measurement);
  if (exit !== expected || exceeded) {
    // Scratch paths may be useful in a local failure, but never enter report.json.
    console.error(`[${label}] exit=${exit}\n${stdout.slice(0, 4000)}\n${stderr.slice(0, 4000)}`);
  }
  assert.equal(exceeded, false, label); assert.equal(exit, expected, label);
  return { stdout, stderr, measurement };
}
const offlineGuard = join(scratch, 'offline-guard.mjs'), witness = join(scratch, 'guard-events.jsonl');
write(offlineGuard, `import fs from 'node:fs';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
const refuse = () => { fs.appendFileSync(${JSON.stringify(witness)}, 'network-attempt\\n'); throw new Error('QUALIFICATION_NETWORK_FORBIDDEN'); };
globalThis.fetch = refuse; net.Socket.prototype.connect = refuse;
for (const module of [http, https, net, tls, dns]) for (const key of ['request','get','connect','createConnection','createServer','lookup','resolve'])
  if (typeof module[key] === 'function') module[key] = refuse;
syncBuiltinESMExports();\n`);

try {
  await run('offline-install', 'npm', ['install', '--offline', '--ignore-scripts', '--omit=optional',
    '--no-audit', '--no-fund', '--package-lock=false', archive], { cwd: install });
  const dependencies = Object.keys(json(join(install, 'package.json')).dependencies ?? {});
  assert.equal(dependencies.length, 1);
  assert.match(dependencies[0], /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u);
  const installed = join(install, 'node_modules', ...dependencies[0].split('/'));
  const manifest = json(join(installed, 'package.json')), build = json(join(installed, 'lib/build-info.json'));
  assert.equal(manifest.name, dependencies[0]); assert.match(build.buildId, /^[a-f0-9-]{36}$/u);
  Object.assign(report, { package: manifest.name, version: manifest.version, build_id: build.buildId });
  const cli = join(installed, 'bin/cli.mjs');
  const metadata = await run('installed-metadata', process.execPath, ['--import', offlineGuard, '--input-type=module', '-e',
    `import * as brand from ${JSON.stringify(pathToFileURL(join(installed, 'lib/brand.mjs')).href)};
import {LAYOUT} from ${JSON.stringify(pathToFileURL(join(installed, 'lib/layout.mjs')).href)};
import {operationId} from ${JSON.stringify(pathToFileURL(join(installed, 'lib/operation-context.mjs')).href)};
const identity={stack:'inventory',protocol:'http',provider:'https://inventory.example.test/v1',environment:'test',operation:'GET /items/{id}'};
console.log(JSON.stringify({LAYOUT,context:brand.CONTEXT_BASENAME,home:brand.HOME_ENV_NAME,id:operationId(identity),identity}));`]);
  const meta = JSON.parse(metadata.stdout), layout = meta.LAYOUT;
  env[meta.home] = join(home, 'machine');
  const command = (label, args, settings = {}) => run(label, process.execPath, ['--import', offlineGuard, cli, ...args], settings);
  function stack(root, name, baseUrl, contractFile) {
    const folder = join(root, layout.collection, name);
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(root, contractFile), join(folder, basename(contractFile)));
    write(join(folder, 'stack.json'), { v: 1, name, title: `${name} synthetic API`, default_environment: 'test',
      contract: basename(contractFile), environments: { test: { baseUrl } } });
    mkdirSync(join(root, layout.evidence, name), { recursive: true, mode: 0o700 });
  }
  write(join(fixture, 'service/openapi.json'), spec('Inventory', ['/items', '/items/{id}']));
  write(join(fixture, 'service/routes.mjs'), 'app.get("/items", list);\napp.get("/items/:id", get);\n');
  write(join(fixture, 'contracts/orders.json'), spec('Orders', ['/orders']));
  stack(fixture, 'inventory', 'https://inventory.example.test/v1', 'service/openapi.json');
  stack(fixture, 'orders', 'https://orders.example.test', 'contracts/orders.json');
  write(join(fixture, 'src/client.mjs'), 'const BASE = "https://inventory.example.test/v1";\nconst SECOND = "https://inventory.example.test/v1";\nconst THIRD = "https://inventory.example.test/v1";\nfetch(`${BASE}/items`);\n');
  const at = '2026-10-17T01:00:00.000Z';
  write(join(fixture, layout.collection, 'inventory', meta.context), { v: 0, api: { name: 'Inventory' }, operations: {},
    api_context: { v: 1, operations: { [meta.id]: { identity: meta.identity, observations: [], omitted_observations: 0,
      key_sources: [{ param: 'id', location: 'path', source: { operation: 'GET /items', field: 'data[].id' },
        first_observed_at: at, last_observed_at: at, also_seen: 1,
        evidence: { run_id: 'run-source', digest: `sha256:${'a'.repeat(64)}` } }] } } } });
  write(join(fixture, layout.suites, 'flow.json'), { stack: 'inventory', environment: 'test', requests: [
    { method: 'GET', path: '/items', capture: { item: 'data.0.id' } }, { method: 'GET', path: '/items/{item}' } ] });
  await run('fixture-git-init', 'git', ['init', '-q']);
  await run('fixture-git-add', 'git', ['add', '.']);
  await run('fixture-git-commit', 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'synthetic inputs']);
  check('isolated offline core-only installation; no development or private modules');

  const cold = JSON.parse((await command('generate-cli-first', ['survey', 'generate', '--exclude-env'])).stdout);
  assert.equal(cold.state, 'generated');
  const graphFile = join(fixture, layout.directory, 'graph/survey.json'), before = readFileSync(graphFile), mtime = statSync(graphFile).mtimeMs;
  const graph = JSON.parse(before);
  assert.equal(graph.relationships.filter(edge => edge.kind === 'calls').length, 1);
  assert.equal(graph.relationships.filter(edge => edge.kind === 'defines').length, 2);
  assert.ok(graph.nodes.find(node => node.kind === 'host' && node.host.includes('inventory.example.test')).references.length >= 3);
  const flow = graph.relationships.find(edge => edge.kind === 'supplies');
  assert.equal(flow.declarations.length, 1); assert.equal(flow.observations.length, 1);
  assert.equal(flow.observations[0].proof.state, 'unavailable');
  assert.ok(graph.relationships.every(edge => edge.kind !== 'imports'));
  report.graph = { snapshot: graph.snapshot, nodes: graph.nodes.length, relationships: graph.relationships.length,
    bytes: before.length, coverage: graph.coverage };
  check('conservative two-stack graph; host references are not calls; declared and retained supplies stay distinct');
  const repeated = JSON.parse((await command('generate-cli-repeated', ['survey', 'generate', '--exclude-env'])).stdout);
  assert.equal(repeated.state, 'unchanged'); assert.deepEqual(readFileSync(graphFile), before); assert.equal(statSync(graphFile).mtimeMs, mtime);
  report.generation_costs = { cli: { meaning: 'Separate fresh CLI processes; repeated means an existing unchanged artifact, not a warm process cache.',
    first: cold.diagnostics, repeated: repeated.diagnostics } };
  const processCosts = await run('generate-same-process-cold-warm', process.execPath, ['--import', offlineGuard, '--input-type=module', '-e',
    `import assert from 'node:assert/strict'; import {readFileSync,statSync} from 'node:fs';
import {generateSurvey} from ${JSON.stringify(pathToFileURL(join(installed, 'lib/survey.mjs')).href)};
const root=${JSON.stringify(fixture)}, file=${JSON.stringify(graphFile)};
const before=readFileSync(file), mtime=statSync(file).mtimeMs, measurements=[];
for(const cache of ['cold','warm']) {
  const started=performance.now(), result=generateSurvey(root,{excludeEnv:true});
  const duration_ms=Math.round((performance.now()-started)*100)/100;
  assert.equal(result.state,'unchanged'); assert.deepEqual(readFileSync(file),before); assert.equal(statSync(file).mtimeMs,mtime);
  measurements.push({cache,state:result.state,duration_ms,diagnostics:result.diagnostics});
}
console.log(JSON.stringify({meaning:'Two unchanged generations in the same installed-module process; the first source cache is cold and the second can reuse it.',measurements}));`]);
  report.generation_costs.same_process = JSON.parse(processCosts.stdout);
  const checked = JSON.parse((await command('status', ['survey', 'status'])).stdout);
  assert.equal(checked.source.state, 'unknown', 'explicit environment exclusion leaves a scoped unknown');
  assert.equal(checked.source.structural_state, 'same'); assert.equal(checked.observations.state, 'unknown');
  assert.equal(checked.base_commit.state, 'available'); report.status = checked;
  const queried = await command('query-bounded', ['survey', 'query', '--stack', 'inventory', '--operation', 'GET /items', '--max-bytes', '1024']);
  assert.ok(Buffer.byteLength(queried.stdout) <= 1024);
  const query = JSON.parse(queried.stdout); assert.equal(query.snapshot.id, graph.snapshot.id);
  assert.ok(query.omitted.nodes + query.omitted.relationships > 0);
  report.query = { bytes: Buffer.byteLength(queried.stdout), omitted: query.omitted };
  const stackFile = join(fixture, layout.collection, 'inventory/stack.json'), stackBytes = readFileSync(stackFile);
  write(stackFile, '{broken');
  await command('generate-invalid-preserves', ['survey', 'generate'], { expected: 1 });
  assert.deepEqual(readFileSync(graphFile), before); writeFileSync(stackFile, stackBytes);
  check('unchanged and failed generation preserve snapshot bytes; bounded query and scoped freshness');

  const projections = {};
  for (const format of ['json', 'dot', 'html']) {
    const file = `projection.${format}`;
    await command(`render-${format}`, ['survey', 'render', '--format', format, '--out', file]);
    projections[format] = readFileSync(join(fixture, file), 'utf8');
    copyFileSync(join(fixture, file), join(output, `survey.${format}`));
    report.artifacts.push({ file: `survey.${format}`, sha256: sha(projections[format]), bytes: Buffer.byteLength(projections[format]) });
  }
  assert.deepEqual(JSON.parse(projections.json), graph);
  for (const row of [...graph.nodes, ...graph.relationships]) for (const format of ['dot', 'html'])
    assert.ok(projections[format].includes(row.id), `${format} identity parity`);
  for (const format of ['dot', 'html']) for (const value of ['run-source', 'data[].id', 'unavailable'])
    assert.ok(projections[format].includes(value), `${format} provenance parity`);
  assert.doesNotMatch(projections.html, /<script\b|<(?:iframe|img|link|object)\b|\s(?:src|href)=["']https?:/iu);
  assert.ok(projections.html.includes("default-src 'none'"));
  for (const bytes of Object.values(projections)) assert.ok(!bytes.includes(scratch) && !bytes.includes(home));
  const afterRenders = JSON.parse((await command('status-after-renders', ['survey', 'status'])).stdout);
  assert.equal(afterRenders.source.state, 'unknown'); assert.equal(afterRenders.source.structural_state, 'same');
  assert.equal(JSON.parse((await command('generate-after-renders', ['survey', 'generate', '--exclude-env'])).stdout).state, 'unchanged');
  assert.deepEqual(readFileSync(graphFile), before);
  check('JSON/DOT/HTML identity and provenance parity; offline CSP; registered outputs do not stale themselves');

  // Exercise privacy repairs through the installed CLI and serializer. Ordinary
  // query values and attribution paths must be withheld even without token-like
  // spelling; the specimen values below are synthetic, not user data.
  const privacyRoot = join(scratch, 'privacy-project'); mkdirSync(privacyRoot);
  const privacyMarker = 'ordinary-private-account', pathMarker = 'private-marker';
  const privatePath = ['', 'Users', 'privacy-fixture', 'private-marker'].join('/');
  const unsafeAuthors = [`file://${privatePath}`, `prefix:${privatePath}`,
    `Reviewer https://example.test/?account=${privacyMarker}`, `Reviewer https://example.test/%3Faccount%3D${privacyMarker}`];
  write(join(privacyRoot, 'openapi.json'), spec('Inventory', ['/items', '/items/{id}']));
  stack(privacyRoot, 'inventory', 'https://inventory.example.test/v1', 'openapi.json');
  write(join(privacyRoot, 'src/routes.mjs'), `app.get('/unmatched?account=${privacyMarker}', handler);\napp.get('/other#${privacyMarker}', handler);\n`);
  write(join(privacyRoot, layout.suites, 'flow.json'), { stack: 'inventory', environment: 'test', requests: [
    { method: 'GET', path: '/items', capture: { item: 'data.0.id' } }, { method: 'GET', path: '/items/{item}' } ] });
  const binding = { from: flow.from, to: flow.to, source_field: flow.source_field, target_parameter: flow.target_parameter,
    environment: 'test', at };
  write(join(privacyRoot, layout.graphManifest), { operator_bindings: [
    { ...binding, author: 'Fixture reviewer' }, ...unsafeAuthors.map(author => ({ ...binding, author })) ] });
  await command('privacy-generate', ['survey', 'generate', '--exclude-env'], { cwd: privacyRoot });
  const privateGraph = json(join(privacyRoot, layout.directory, 'graph/survey.json'));
  const privateFlow = privateGraph.relationships.find(edge => edge.kind === 'supplies');
  assert.deepEqual(privateFlow.operator_attributions.map(row => row.author), ['Fixture reviewer']);
  assert.ok(privateGraph.coverage.withheld.metadata > 0);
  assert.ok(privateGraph.unresolved.some(row => row.reason === 'operator-attribution-withheld'));
  for (const format of ['json', 'dot', 'html']) {
    const rendered = (await command(`privacy-render-${format}`, ['survey', 'render', '--format', format], { cwd: privacyRoot })).stdout;
    assert.ok(!rendered.includes(privacyMarker) && !rendered.includes(pathMarker));
  }
  await run('privacy-model-boundary', process.execPath, ['--import', offlineGuard, '--input-type=module', '-e',
    `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
import {createSurveySnapshot} from ${JSON.stringify(pathToFileURL(join(installed, 'lib/survey-model.mjs')).href)};
const graph=JSON.parse(readFileSync(${JSON.stringify(graphFile)},'utf8'));
for(const author of ${JSON.stringify(unsafeAuthors)}) {
  const edge={...graph.relationships[0],operator_attributions:[{kind:'operator-annotation',author,at:'2026-10-17'}]};
  assert.throws(()=>createSurveySnapshot({nodes:graph.nodes,relationships:[edge]}),error=>error.code==='SURVEY_UNSAFE_METADATA');
}
for(const fields of [{path:'/unmatched?account=${privacyMarker}'},{path:'/unmatched%3Faccount%3D${privacyMarker}'},
  {operation:'GET /items%253Faccount%253D${privacyMarker}'},{host:'inventory.example.test?account=${privacyMarker}'}])
  assert.throws(()=>createSurveySnapshot({unresolved:[{kind:'call',reason:'no-unique-bound-operation',...fields}]}));
console.log(JSON.stringify({unsafe_authors_refused:${unsafeAuthors.length},unsafe_unresolved_records_refused:4}));`]);
  check('unmatched query/fragment routes and unsafe attribution metadata are withheld in every installed projection');

  const requests = [], requestRoot = join(scratch, 'requests'); mkdirSync(requestRoot);
  server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    const okay = req.method === 'GET' && ['/inventory/v1/items', '/inventory/v1/items/synthetic-item'].includes(req.url);
    res.writeHead(okay ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(okay ? req.url.endsWith('/synthetic-item') ? { id: 'synthetic-item', state: 'ready' }
      : { data: [{ id: 'synthetic-item', state: 'ready' }] } : { error: 'fixture route not found' }));
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port, base = `http://127.0.0.1:${port}/inventory/v1`;
  write(join(requestRoot, 'inventory.json'), spec('Loopback Inventory', ['/items', '/items/{id}']));
  stack(requestRoot, 'inventory', base, 'inventory.json');
  for (let index = 0; index < 7; index++) write(join(requestRoot, `consumer-${index}.mjs`),
    `const BASE = ${JSON.stringify(base)};\nfetch(\`\${BASE}/items\`);\n`);
  const loader = join(scratch, 'request-loader.mjs'), requestGuard = join(scratch, 'request-guard.mjs');
  write(loader, `import fs from 'node:fs';
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (/\\/lib\\/survey(?:[.-]|\\.mjs)/u.test(result.url)) {
    fs.appendFileSync(${JSON.stringify(witness)}, 'survey-module-attempt\\n'); throw new Error('QUALIFICATION_SURVEY_LOAD_FORBIDDEN');
  }
  return result;
}\n`);
  write(requestGuard, `import fs from 'node:fs'; import fsp from 'node:fs/promises'; import net from 'node:net'; import tls from 'node:tls';
import {register,syncBuiltinESMExports} from 'node:module';
register(new URL('./request-loader.mjs', import.meta.url));
const refuse = kind => { fs.appendFileSync(${JSON.stringify(witness)}, kind+'\\n'); throw new Error('QUALIFICATION_PATH_FORBIDDEN'); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!value || typeof value !== 'object' || value.host !== '127.0.0.1' || Number(value.port) !== ${port}) refuse('non-loopback-attempt');
  return connect.apply(this,args);
};
tls.connect = () => refuse('tls-attempt');
for (const [module,keys] of [[fs,['readFileSync','openSync','readFile','open']],[fsp,['readFile','open']]]) for (const key of keys) {
  const original = module[key]; module[key] = function(file,...rest) {
    const path = file instanceof URL ? file.pathname : String(file);
    if (path.endsWith('/graph/survey.json')) refuse('survey-artifact-read-attempt');
    return original.call(this,file,...rest);
  };
}
syncBuiltinESMExports();\n`);
  const requestEnv = { API_CONTEXT_DIR: requestRoot, API_USAGE_LOG: join(home, 'usage.jsonl'), API_BUDGET: '6000', API_FRICTION_OFF: '1' };
  async function request(label, extraEnv = {}) {
    const result = await run(label, process.execPath, ['--import', requestGuard, cli, 'request', 'GET', '/items',
      '--stack', 'inventory', '--env', 'test', '--expect-status', '200'], { cwd: requestRoot, extraEnv: { ...requestEnv, ...extraEnv } });
    const value = JSON.parse(result.stdout); assert.equal(value.ok, true); assert.equal(value.status, 200); assert.equal(value.stack, 'inventory');
    return { value, bytes: Buffer.byteLength(result.stdout) };
  }
  const without = await request('request-no-survey');
  await command('request-fixture-generate', ['survey', 'generate', '--exclude-env'], { cwd: requestRoot });
  const savedRequestGraph = readFileSync(join(requestRoot, layout.directory, 'graph/survey.json'));
  const withSurvey = await request('request-with-survey');
  assert.deepEqual(withSurvey.value.known.code, without.value.known.code);
  assert.deepEqual(withSurvey.value.known.code.called_from, Array.from({ length: 5 }, (_, index) => `consumer-${index}.mjs:2`));
  assert.equal(withSurvey.value.known.code.omitted, 2);
  const off = await request('request-context-off', { API_CONTEXT_OFF: '1' }); assert.equal(off.value.known, null);
  const bounded = await request('request-budgeted', { API_BUDGET: '500' });
  assert.ok(Math.ceil(JSON.stringify(bounded.value).length / 4) <= 500 || bounded.value.budget_min);
  if (!bounded.value.known?.code) assert.ok(bounded.value.known?.withheld?.code || bounded.value.known?.withheld?.known);
  assert.deepEqual(readFileSync(join(requestRoot, layout.directory, 'graph/survey.json')), savedRequestGraph);
  assert.equal(requests.length, 4); assert.ok(requests.every(row => row.method === 'GET' && row.path === '/inventory/v1/items'));
  assert.equal(existsSync(witness), false, 'no forbidden network, survey import or survey artifact read was attempted');
  report.request = { requests: requests.length, network: 'synthetic-loopback-only', known_code: withSurvey.value.known.code,
    known_code_bytes: Buffer.byteLength(JSON.stringify(withSurvey.value.known.code)),
    envelope_bytes: { without_survey: without.bytes, with_survey: withSurvey.bytes, context_off: off.bytes, budgeted: bounded.bytes },
    survey_load_attempts: 0, survey_artifact_read_attempts: 0, context_off_known: off.value.known };
  check('named-stack request retains five-location CODE-1 cap and budget; context-off disables known context');
  check('request behavior is unchanged by a saved graph; no survey module, artifact read, regeneration or status work');

  // A real client capture feeds the next GET. Its saved value-match relationship
  // is distinct from the seeded, deliberately proof-unavailable offline model.
  const transferFile = join(requestRoot, layout.suites, 'executed-transfer.json');
  write(transferFile, { stack: 'inventory', environment: 'test', requests: [
    { protocol: 'http', method: 'GET', path: '/items', expect: [{ status: 200 }], capture: { item: 'data.0.id' } },
    { protocol: 'http', method: 'GET', path: '/items/{item}', expect: [{ status: 200 }, { json: 'state', equals: 'ready' }] },
  ] });
  const transferred = await run('executed-transfer', process.execPath, ['--import', requestGuard, cli, 'protocol', transferFile],
    { cwd: requestRoot, extraEnv: requestEnv });
  const transfer = JSON.parse(transferred.stdout);
  assert.equal(transfer.ok, true); assert.equal(transfer.attempted, 2); assert.equal(transfer.results.length, 2);
  assert.ok(transfer.results.every(result => result.ok && result.status === 200));
  assert.deepEqual(requests.slice(4), [{ method: 'GET', path: '/inventory/v1/items' },
    { method: 'GET', path: '/inventory/v1/items/synthetic-item' }]);
  await command('executed-transfer-generate', ['survey', 'generate', '--exclude-env'], { cwd: requestRoot });
  const executedBytes = readFileSync(join(requestRoot, layout.directory, 'graph/survey.json'));
  const executedGraph = JSON.parse(executedBytes), executedFlow = executedGraph.relationships.find(edge => edge.kind === 'supplies');
  assert.ok(executedFlow, 'the actual transfer must retain a supplies relationship');
  assert.equal(executedFlow.source_field, 'data[].id');
  assert.deepEqual(executedFlow.target_parameter, { location: 'path', name: 'id' });
  assert.ok(executedFlow.declarations.length > 0 && executedFlow.observations.length > 0);
  assert.ok(executedFlow.observations.every(observation => observation.proof.state === 'matching'));
  assert.ok(!executedBytes.includes('synthetic-item'), 'identifier values stay out of the portable graph');
  assert.equal(existsSync(witness), false);
  writeFileSync(join(output, 'executed-transfer.json'), executedBytes, { mode: 0o600 });
  report.artifacts.push({ file: 'executed-transfer.json', sha256: sha(executedBytes), bytes: executedBytes.length });
  report.executed_transfer = { requests: 2, assertions: 'HTTP 200 for both steps; detail state equals ready',
    relationship: executedFlow, snapshot: executedGraph.snapshot, private_proof: 'matching at qualification time' };
  check('fresh asserted two-step loopback capture produces a retained supplies edge with matching local proof');
  assert.equal(sha(readFileSync(archive)), report.package_sha256, 'exact package remains unchanged');
  report.state = 'passed';
} catch (error) {
  console.error(`[${phase}] ${String(error?.stack ?? error).slice(0, 4000)}`);
  report.error = cleanFailure(error); process.exitCode = 1;
} finally {
  if (server) await new Promise(accept => server.close(accept));
  write(join(output, 'report.json'), report);
  // Only this process's newly-created scratch tree is removed. Results remain.
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ state: report.state, report: join(output, 'report.json'), package_sha256: report.package_sha256,
  build_id: report.build_id, checks: report.checks.length, error: report.error }, null, 2));
