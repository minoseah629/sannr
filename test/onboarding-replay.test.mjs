// Continuation reads saved metadata in a new process; it must not repeat a probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME, NPM_PACKAGE, POINTER_CLI_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { setupGuidance } from '../lib/onboarding.mjs';
import { ONBOARDING_OBSERVATION_PATH, queryDoctorObservation, recordDoctorObservation,
  renderDoctorObservation } from '../lib/doctor-observation.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const execute = promisify(execFile);
const first = {
  purpose: 'onboarding', observed_at: '2026-09-27T18:00:00.000Z', target_source: 'default',
  provider: 'https://api.github.com', method: 'GET', url: 'https://api.github.com/zen', status: 200,
  http_ok: true, duration_ms: 37, rate_limit_headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' },
  evidence_id: 'run-11111111-1111-4111-8111-111111111111',
  authentication: 'not_sent', assertions: 'not_run', repo_contract: null,
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-replay-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_|SANNR_|NODE_OPTIONS)/.test(key)));
  Object.assign(env, { HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'private-home') });
  return { root, env };
}

async function run(f, ...args) {
  try {
    return { code: 0, ...await execute(process.execPath, [CLI, ...args], { cwd: f.root, env: f.env, timeout: 12000 }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('human replay retains the first success and latest non-2xx observation across processes without traffic or a contract', async t => {
  const f = fixture(t);
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end('unexpected probe'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(f.root, LAYOUT.config), { recursive: true });
  writeFileSync(join(f.root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: { local: { baseUrl: url } } }));
  const setup = await run(f, 'start', '--json');
  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false);
  recordDoctorObservation(f.root, first);
  const latest = { ...first, observed_at: '2026-09-28T18:00:00.000Z', target_source: 'configured',
    provider: url, method: 'HEAD', url: `${url}/`, status: 404, http_ok: false, duration_ms: 12,
    rate_limit_headers: {}, evidence_id: 'run-22222222-2222-4222-8222-222222222222' };
  recordDoctorObservation(f.root, latest);
  const path = join(f.root, ONBOARDING_OBSERVATION_PATH);
  const before = readFileSync(path);
  // No raw evidence file is present: replay must neither need it nor replace it.
  const replay = await run(f, 'context', 'query', '--onboarding', '--human');
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(replay.stderr, '');
  assert.match(replay.stdout, /Saved onboarding observations \(historical\)/);
  assert.match(replay.stdout, /First: 2026-09-27T18:00:00\.000Z/);
  assert.match(replay.stdout, /Latest: 2026-09-28T18:00:00\.000Z/);
  assert.match(replay.stdout, /GET https:\/\/api\.github\.com\/zen/);
  assert.ok(replay.stdout.includes(`HEAD ${url}/`));
  assert.match(replay.stdout, /HTTP: 200 \(2xx response\); latency: 37 ms/);
  assert.match(replay.stdout, /HTTP: 404 \(non-2xx response\); latency: 12 ms/);
  assert.match(replay.stdout, /x-ratelimit-limit=60; x-ratelimit-remaining=59/);
  assert.match(replay.stdout, /Rate limits: not recorded/);
  assert.ok(replay.stdout.includes(first.evidence_id));
  assert.ok(replay.stdout.includes(latest.evidence_id));
  assert.match(replay.stdout, /authentication not_sent; assertions not_run; repository contract: none/);
  assert.match(replay.stdout, /Retrieval executed 0 requests/);
  assert.match(replay.stdout, /Current API behavior and evidence-file availability were not rechecked/);
  assert.doesNotMatch(replay.stdout, /fortune|About to request:|PASS|verified by execution/);
  assert.deepEqual(readFileSync(path), before);
  const json = await run(f, 'context', 'query', '--onboarding');
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), queryDoctorObservation(f.root), 'default JSON remains the existing metadata projection');
  assert.equal(hits, 0, 'neither setup nor resumed retrieval may contact the configured API');
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false, 'replay must not invent repository API knowledge');
  assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /even when no contract or knowledge file exists/);
});

test('missing and damaged onboarding receipts are explicit and never reconstructed or repaired', async t => {
  const f = fixture(t);
  const missing = await run(f, 'context', 'query', '--onboarding', '--human');
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stdout, /No saved onboarding observation is available/);
  assert.match(missing.stdout, /Offline setup does not create a probe observation/);
  assert.match(missing.stdout, /The saved record does not explain its absence/);
  assert.match(missing.stdout, /removed record/);
  assert.match(missing.stdout, /First and latest observations are unavailable/);
  assert.doesNotMatch(missing.stdout, /auth(?:entication)? (?:failed|fails)|server (?:down|unreachable)/i);
  const missingJson = await run(f, 'context', 'query', '--onboarding');
  assert.equal(missingJson.code, 0, missingJson.stderr);
  assert.equal(JSON.parse(missingJson.stdout).missing_reason, 'record_absent');
  assert.match(missing.stdout, /Retrieval executed 0 requests/);
  assert.equal(existsSync(join(f.root, ONBOARDING_OBSERVATION_PATH)), false);
  mkdirSync(join(f.root, LAYOUT.evidence), { recursive: true });
  const path = join(f.root, ONBOARDING_OBSERVATION_PATH);
  writeFileSync(path, '{private-damaged-receipt');
  const invalid = await run(f, 'context', 'query', '--onboarding', '--human');
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /ONBOARDING_OBSERVATION_INVALID/);
  assert.match(invalid.stderr, /unavailable or damaged/);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-damaged-receipt|About to request:/);
  assert.equal(readFileSync(path, 'utf8'), '{private-damaged-receipt');
  rmSync(path);
  const target = join(f.root, 'private-sentinel');
  writeFileSync(target, 'private-sentinel-contents');
  symlinkSync(target, path);
  const unsafe = await run(f, 'context', 'query', '--onboarding', '--human');
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /ONBOARDING_OBSERVATION_UNSAFE/);
  assert.doesNotMatch(unsafe.stdout + unsafe.stderr, /private-sentinel-contents/);
  assert.equal(readFileSync(target, 'utf8'), 'private-sentinel-contents');
});

test('pure renderer projects allowlisted metadata and rejects invalid observations', () => {
  const receipt = { v: 1, scope: 'onboarding', state: 'recorded', first, latest: first,
    checks: ['private-check-output'], body: 'private-fortune', meaning: 'private-injected-instruction' };
  const rendered = renderDoctorObservation(receipt);
  assert.doesNotMatch(rendered, /private-/);
  assert.match(rendered, /not a full doctor report/);
  assert.throws(() => renderDoctorObservation({ ...receipt, latest: { ...first, authentication: 'verified' } }),
    { code: 'ONBOARDING_OBSERVATION_INVALID' });
});

test('finish guidance replays observations after activation with an installed invocation or metadata-only fallback', () => {
  const binding = `setup-v1:${'a'.repeat(64)}`;
  for (const cli of [`npx --yes ${NPM_PACKAGE}@${VERSION}`, POINTER_CLI_NAME, null]) {
    const guidance = setupGuidance(binding, cli);
    assert.ok(guidance.includes(`Setup binding: ${binding}`));
    assert.ok(guidance.indexOf('Confirm activation only') < guidance.indexOf('After confirming activation'));
    if (cli) assert.ok(guidance.includes(`\`${cli} context query --onboarding --human\``));
    else {
      assert.ok(guidance.includes(`\`${ONBOARDING_OBSERVATION_PATH}\``));
      assert.doesNotMatch(guidance, /npx|node_modules|context query --onboarding/);
    }
    assert.match(guidance, /even when no contract or knowledge file exists/);
    assert.match(guidance, /first and latest observations separately from the API inventory/);
    assert.match(guidance, /missing, damaged, or unsafe to read/);
    assert.match(guidance, /Do not run doctor or API requests/);
    assert.match(guidance, /without running another probe/);
  }
});
