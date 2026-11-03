import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME, HOME_ENV_NAME } from '../lib/brand.mjs';

const cli = new URL('../bin/cli.mjs', import.meta.url).pathname;
const view = new URL('../lib/view.mjs', import.meta.url).href;
const request = new URL('../bin/request.mjs', import.meta.url).pathname;
const feedback = new URL('../lib/feedback.mjs', import.meta.url).href;
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'r11-consumers-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, 'consumer-fixture'), current = join(home, `.${STATE_DIR_NAME}`), legacy = join(home, `.${LEGACY_STATE_DIR_NAME}`);
  for (const path of [repo, current, legacy]) mkdirSync(path, { mode: 0o700 });
  const row = (id, day, project = 'consumer-fixture') => ({ runId: id, ts: `2026-10-0${day}T00:00:00.000Z`, project, origin: 'own', host: 'example.test', status: 200, ok: true, rawBytes: 40, envelopeBytes: 20, tokensSaved: 5 });
  writeFileSync(join(current, 'usage.jsonl'), `${JSON.stringify(row('new', 7))}\n`);
  writeFileSync(join(legacy, 'usage.jsonl'), `${JSON.stringify(row('old', 6))}\n${JSON.stringify(row('other', 5, 'another-repo'))}\n`);
  return { home, repo, current, legacy };
}
function child(f, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: f.home, NO_COLOR: '1', ...extra };
    const p = spawn(process.execPath, args, { cwd: f.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b);
    p.on('error', reject); p.on('close', exit => resolve({ exit, stdout, stderr }));
  });
}
const json = result => { assert.equal(result.exit, 0, result.stderr); return JSON.parse(result.stdout); };

test('R11 receipt counts both logs, scopes the repo, and names both read sources', async t => {
  const f = fixture(t);
  const r = json(await child(f, [cli, 'receipt', '--json']));
  assert.equal(r.calls, 2);
  assert.equal(r.scope.rows_total_machine, 3);
  assert.deepEqual(r.logs.map(log => [log.source, log.rows]), [['current', 1], ['legacy', 2]]);
  assert.deepEqual(r.logs.map(log => log.path), [join(f.current, 'usage.jsonl'), join(f.legacy, 'usage.jsonl')]);
  assert.equal(r.window.from, '2026-10-06T00:00:00.000Z');
  assert.equal(r.window.to, '2026-10-07T00:00:00.000Z');
  const human = await child(f, [cli, 'receipt']);
  assert.equal(human.exit, 0, human.stderr);
  assert.match(human.stdout, /current.*usage\.jsonl/);
  assert.match(human.stdout, /legacy.*usage\.jsonl/);
  assert.equal(existsSync(join(f.legacy, 'usage.jsonl')), true);
});

test('R11 request report aggregates both logs and discloses both paths', async t => {
  const f = fixture(t), r = await child(f, [request, '--report']);
  assert.equal(r.exit, 0, r.stderr);
  assert.match(r.stdout, /^3 calls/m);
  assert.ok(r.stdout.includes(join(f.current, 'usage.jsonl')));
  assert.ok(r.stdout.includes(join(f.legacy, 'usage.jsonl')));
  assert.match(r.stdout, /current/); assert.match(r.stdout, /legacy/);
});

test('R11 public request --report reaches static accounting without selecting request config', async t => {
  const f = fixture(t), r = await child(f, [cli, 'request', '--report'], { API_CONFIG: join(f.repo, 'missing-config.json') });
  assert.equal(r.exit, 0, r.stderr);
  assert.match(r.stdout, /^3 calls/m);
  assert.match(r.stdout, /current/); assert.match(r.stdout, /legacy/);
});

test('R11 feedback counts both logs and discloses non-identifying sources without machine paths', async t => {
  const f = fixture(t), r = json(await child(f, [cli, 'feedback', '--json']));
  assert.equal(r.usage.calls, 2); assert.equal(r.usage.machine_wide_calls, 3);
  assert.equal(r.what_it_saved.calls, 2);
  assert.deepEqual(r.usage.log_sources, [{ source: 'current', rows: 1 }, { source: 'legacy', rows: 2 }]);
  assert.equal(JSON.stringify(r).includes(f.home), false);
  const output = join(f.repo, 'feedback.md');
  const human = await child(f, [cli, 'feedback', '--out', output]);
  assert.equal(human.exit, 0, human.stderr);
  assert.match(readFileSync(output, 'utf8'), /current/);
  assert.match(readFileSync(output, 'utf8'), /legacy/);
});

test('R11 usage readers reject linked default files and ancestors, but still count the other safe log', async t => {
  for (const which of ['current', 'legacy']) for (const directory of [false, true]) {
    const f = fixture(t), target = join(f.home, 'linked-source'); mkdirSync(target);
    writeFileSync(join(target, 'usage.jsonl'), '{"status":299,"runId":"linked-secret"}\n');
    if (directory) { rmSync(f[which], { recursive: true }); symlinkSync(target, f[which]); }
    else { rmSync(join(f[which], 'usage.jsonl')); symlinkSync(join(target, 'usage.jsonl'), join(f[which], 'usage.jsonl')); }
    const rows = json(await child(f, ['--input-type=module', '-e', `import { readUsage } from ${JSON.stringify(feedback)}; console.log(JSON.stringify(readUsage()));`]));
    assert.equal(rows.some(row => row.runId === 'linked-secret'), false);
    assert.equal(rows.length, which === 'current' ? 2 : 1);
  }
});

test('R11 explicit and disabled usage overrides are exclusive and linked overrides are not read', async t => {
  const f = fixture(t), override = join(f.home, 'override.jsonl');
  writeFileSync(override, '{"status":202}\n');
  const code = `import { readUsage } from ${JSON.stringify(feedback)}; console.log(JSON.stringify(readUsage()));`;
  assert.deepEqual(json(await child(f, ['--input-type=module', '-e', code], { API_USAGE_LOG: override })), [{ status: 202 }]);
  assert.deepEqual(json(await child(f, ['--input-type=module', '-e', code], { API_USAGE_LOG: '' })), []);
  const linked = join(f.home, 'override-link.jsonl'); symlinkSync(override, linked);
  assert.deepEqual(json(await child(f, ['--input-type=module', '-e', code], { API_USAGE_LOG: linked })), []);
  const explicitCode = `import { readUsage } from ${JSON.stringify(feedback)}; console.log(JSON.stringify(readUsage(${JSON.stringify(linked)})));`;
  assert.deepEqual(json(await child(f, ['--input-type=module', '-e', explicitCode])), []);
});

test('R11 state override reads its current log and legacy log without moving either', async t => {
  const f = fixture(t), custom = join(f.home, 'custom-state'); mkdirSync(custom);
  writeFileSync(join(custom, 'usage.jsonl'), '{"status":201}\n');
  const rows = json(await child(f, ['--input-type=module', '-e', `import { readUsage } from ${JSON.stringify(feedback)}; console.log(JSON.stringify(readUsage()));`], { [HOME_ENV_NAME]: custom }));
  assert.deepEqual(rows.map(row => row.status).sort(), [200, 200, 201]);
  assert.equal(existsSync(join(f.legacy, 'usage.jsonl')), true);
});

test('R11 doctor gives one legacy-state diagnostic with read locations and names leftovers only once', async t => {
  const f = fixture(t);
  for (const dir of [f.current, f.legacy]) mkdirSync(join(dir, 'tokens'));
  writeFileSync(join(f.legacy, 'keep.txt'), 'SYNTHETIC-PRIVATE-TEXT');
  writeFileSync(join(f.legacy, 'tokens', 'fixture.json'), '{"accessToken":"SYNTHETIC-PRIVATE-TOKEN"}');
  const first = json(await child(f, [cli, 'doctor', '--offline', '--json']));
  const lines = first.checks.filter(check => check.name === 'legacy-state');
  assert.equal(lines.length, 1);
  assert.match(lines[0].detail, /keep\.txt/);
  assert.ok(lines[0].detail.includes(join(f.current, 'usage.jsonl')));
  assert.ok(lines[0].detail.includes(join(f.legacy, 'usage.jsonl')));
  assert.ok(lines[0].detail.includes(join(f.current, 'tokens')));
  assert.ok(lines[0].detail.includes(join(f.legacy, 'tokens')));
  assert.doesNotMatch(JSON.stringify(lines), /SYNTHETIC-PRIVATE|moved automatically/);
  const second = json(await child(f, [cli, 'doctor', '--offline', '--json']));
  const again = second.checks.filter(check => check.name === 'legacy-state');
  assert.equal(again.length, 1); assert.equal(again[0].state, 'PASS');
  assert.doesNotMatch(JSON.stringify(again), /keep\.txt|Files left untouched/);
  assert.equal(existsSync(join(f.legacy, 'tokens', 'fixture.json')), true);
});

test('R11 static view receipt counts and names both sources without exporting machine paths', async t => {
  const f = fixture(t);
  const code = `import { buildViewModel, renderViewHtml } from ${JSON.stringify(view)};
    const model = buildViewModel(process.cwd()); console.log(JSON.stringify({ receipt: model.receipt, html: renderViewHtml(model) }));`;
  const result = json(await child(f, ['--input-type=module', '-e', code]));
  assert.equal(result.receipt.calls, 2);
  assert.deepEqual(result.receipt.log_sources, [{ source: 'current', rows: 1 }, { source: 'legacy', rows: 2 }]);
  assert.match(result.html, /read sources: current &#40;1 machine-wide rows\), legacy &#40;2 machine-wide rows\)/);
  assert.equal(result.html.includes(f.home), false);
});
