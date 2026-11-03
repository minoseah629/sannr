import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOME_ENV_NAME } from "../lib/brand.mjs";
import { CONNECT_VOICE, DOCTOR_ZEN_TEXT_MAX, renderDoctorZen } from "../lib/install-voice.mjs";
import { renderSetupReceipt, setupReceipt } from "../lib/onboarding.mjs";

const zenTarget = { targetSource: "default", method: "GET", url: "https://api.github.com/zen", status: 200 };
const prefix = 'I asked GitHub for a fortune and it said "';
const suffix = '". I can\'t vouch for the advice, only for the round trip.';

test("the human receipt adds approved copy without changing the continuation or JSON", () => {
  const receipt = setupReceipt({ report: { mcp: [], skills: [], pointers: [], credentials: [] },
    cfg: {}, conflicts: false, dryRun: false, cli: "sannr", bindingId: "fixture-binding" });
  const before = JSON.stringify(receipt);
  const text = renderSetupReceipt(receipt);
  assert.ok(text.includes(`Agent access: confirm tool availability in your coding agent.\n${CONNECT_VOICE}\n`));
  assert.ok(text.endsWith(`\n\n${receipt.continuation.instruction}`));
  assert.equal(JSON.stringify(receipt), before);
  assert.doesNotMatch(before, /Sannr here|Nothing's on fire|librarian/);
  for (const variant of [
    { ...receipt, status: "preview", wiring: { ...receipt.wiring, state: "planned" } },
    { ...receipt, status: "attention", wiring: { ...receipt.wiring, state: "blocked" } },
    { ...receipt, status: "attention" },
  ]) assert.ok(!renderSetupReceipt(variant).includes(CONNECT_VOICE));
});

test("only a successful default Zen GET earns an attributed koan", () => {
  assert.equal(renderDoctorZen("Keep it logically awesome", zenTarget), `${prefix}Keep it logically awesome${suffix}`);
  assert.equal(renderDoctorZen("Approachable is better than simple.", zenTarget),
    `${prefix}Approachable is better than simple." I can't vouch for the advice, only for the round trip.`);
  for (const target of [
    { ...zenTarget, targetSource: "override" }, { ...zenTarget, targetSource: "configured" },
    { ...zenTarget, method: "HEAD" }, { ...zenTarget, status: 404 },
    { ...zenTarget, status: 204 }, { ...zenTarget, url: "https://example.com/zen" },
    { ...zenTarget, url: "https://api.github.com/zen?query=value" }, undefined,
  ]) assert.equal(renderDoctorZen("private response body", target), null);
  for (const body of [undefined, null, {}, 12, "", "\n\r\t\u0000\u2066"]) {
    assert.equal(renderDoctorZen(body, zenTarget), null);
  }
});

test("koan output strips terminal escapes and controls, escapes quotes, and stays one bounded line", () => {
  const body = '\u001b[31mKeep\u001b[0m\n\r\t"awesome"\u001b]8;;https://host.invalid\u0007link\u001b]8;;\u0007'
    + '\u2028\u2029\u2066\u202e\u009b2J\\path';
  const text = renderDoctorZen(body, zenTarget);
  assert.ok(text.startsWith(prefix));
  assert.ok(text.endsWith(suffix));
  assert.doesNotMatch(text, /[\p{Cc}\p{Cf}\u2028\u2029]/u);
  assert.doesNotMatch(text, /31m|host\.invalid|2J/);
  assert.ok(text.includes('\\"awesome\\"'));
  assert.ok(text.includes('\\'.repeat(2) + 'path'));
  for (const unbounded of ['x'.repeat(20_000), '"\\'.repeat(5000), '😀'.repeat(5000)]) {
    const rendered = renderDoctorZen(unbounded, zenTarget);
    const quotation = rendered.slice(prefix.length, -suffix.length);
    assert.ok(quotation.length <= DOCTOR_ZEN_TEXT_MAX);
    assert.ok(quotation.endsWith("…"));
    assert.doesNotMatch(quotation, /[\ud800-\udbff]$/u);
  }
});

test("the pointer sentence and human library guide follow the product and layout rename seam", () => {
  const module = new URL("../lib/install-voice.mjs", import.meta.url).href;
  const layout = new URL("../lib/layout.mjs", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const voice = await import(${JSON.stringify(module)}); const layout = await import(${JSON.stringify(layout)}); console.log(voice.CONNECT_VOICE, voice.installPointerSentence(), layout.renderLayoutReadme());`],
  { env: { ...process.env, API_CONTEXT_PRODUCT_NAME: "fixturebrand", API_CONTEXT_COLLECTION_NAME: "lessons" }, encoding: "utf8" });
  assert.match(output, /Fixturebrand here/);
  assert.match(output, /Fixturebrand wrote the lines below/);
  assert.match(output, /in \.fixturebrand\//);
  assert.match(output, /Fixturebrand is the librarian/);
  assert.match(output, /\.fixturebrand\/lessons/);
  assert.doesNotMatch(output, /sannr/i);
});

// One CLI specimen proves the sanitized renderer is wired into doctor; the
// unit matrix above owns attribution/format variants, onboarding owns JSON.
const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(SOURCE, 'bin/cli.mjs');
const ZEN = 'https://api.github.com/zen';
const FORTUNE = 'I asked GitHub for a fortune and it said ';

function fixture(t, { body = 'Keep it logically awesome', status = 200 } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'alpha4-doctor-voice-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), home = join(base, 'home'), log = join(base, 'attempts.jsonl');
  mkdirSync(root); mkdirSync(home);
  const guard = join(base, 'controlled-fetch.mjs');
  writeFileSync(guard, `
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    let announcements = [];
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = (chunk, encoding, callback) => {
        const done = typeof encoding === 'function' ? encoding : callback;
        return original(chunk, typeof encoding === 'string' ? encoding : undefined, error => {
          if (!error && String(chunk).startsWith('About to request: ')) announcements.push(String(chunk));
          done?.(error);
        });
      };
    }
    globalThis.fetch = async (target, options) => {
      const url = String(target), announcement = announcements.shift();
      assert.ok(announcement?.includes(url), 'fetch preceded its completed request announcement');
      assert.ok(url === ${JSON.stringify(ZEN)} || url.startsWith('http://127.0.0.1:9107/'), 'unrecognized request');
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({url,method:options.method,announced:true}) + '\\n');
      return new Response(${JSON.stringify(body)}, { status: ${status}, headers: {
        'content-type': 'text/plain', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59'
      } });
    };
  `);
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'state'),
    API_USAGE_LOG: '', NO_COLOR: '1', NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` };
  const run = (args = [], extraEnv = {}) => {
    const result = spawnSync(process.execPath, [CLI, 'doctor', ...args], {
      cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? '') + (result.error ?? ''));
    return { stdout: result.stdout, stderr: result.stderr,
      attempts: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(row => JSON.parse(row)) : [] };
  };
  return { root, run };
}

test('human doctor sanitizes public Zen text but never prints an override body', t => {
  const body = 'PRIVATE_VOICE_VALUE \u001b[31mRed\u001b[0m\nSecond\r\t"quoted"\u202e ' + 'long '.repeat(800);
  const f = fixture(t, { body });
  const result = f.run();
  const lines = result.stdout.split('\n').filter(row => row.includes(FORTUNE));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length < 400, `${lines[0].length} character display line`);
  assert.doesNotMatch(lines[0], /[\p{Cc}\p{Cf}\u2028\u2029]/u);
  assert.match(lines[0], /Red Second/);
  assert.ok(lines[0].includes('\\"quoted\\"'));
  assert.match(lines[0], /…"\. I can't vouch for the advice, only for the round trip\.$/);
  assert.deepEqual(result.attempts, [{ url: ZEN, method: 'GET', announced: true }]);
  const observation = JSON.parse(readFileSync(join(f.root, '.sannr/evidence/onboarding.json'), 'utf8'));
  const evidence = JSON.parse(readFileSync(join(f.root, '.sannr/evidence', `${observation.latest.evidence_id}.json`), 'utf8'));
  assert.equal(evidence.response.body, body, 'presentation must preserve original evidence bytes');
  const override = f.run(['--probe', 'http://127.0.0.1:9107/override']);
  assert.doesNotMatch(override.stdout + override.stderr, /PRIVATE_VOICE_VALUE|I asked GitHub for a fortune/,
    'human CLI must not print or attribute a private override body');
  assert.deepEqual(override.attempts, [...result.attempts,
    { url: 'http://127.0.0.1:9107/override', method: 'GET', announced: true }]);
});
