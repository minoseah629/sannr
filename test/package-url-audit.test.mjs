import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { candidateFiles, scanUrlLiterals } from '../scripts/audit-package-urls.mjs';

// Audit completeness includes duplicates, non-HTTP schemes, templates and
// comments; parsing a URL must not drop a malformed/illustrative destination.
test('URL inventory retains every literal occurrence and exact source location', () => {
  const source = '// https://example.test twice https://example.test\n' +
    'const ws = `wss://${host}/events`;\nconst base = "http://";\n';
  const result = scanUrlLiterals(new Map([['sample.mjs', Buffer.from(source)]]));
  assert.equal(result.file_count, 1);
  assert.equal(result.occurrence_count, 4);
  assert.equal(result.unique_literal_count, 3);
  assert.deepEqual(result.occurrences.map(x => [x.literal, x.line]), [
    ['https://example.test', 1], ['https://example.test', 1],
    ['wss://${host}/events', 2], ['http://', 3],
  ]);
  for (const entry of result.occurrences)
    assert.equal(source.slice(entry.offset, entry.offset + entry.literal.length), entry.literal);
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
});

test('URL inventory cannot silently skip a binary package member', () => {
  assert.throws(() => scanUrlLiterals(new Map([['unknown.bin', Buffer.from([0xff])]])), /explicit binary review/);
});

test('actual candidate pack list has no Clerk URL; vendor recognition is preserved', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const record = scanUrlLiterals(candidateFiles(root));
  assert.equal(record.occurrences.filter(x => /(?:^|\/)api\.clerk\.com(?:[/:]|$)/i.test(x.literal)).length, 0);
  const source = readFileSync(new URL('../lib/client.mjs', import.meta.url), 'utf8');
  assert.match(source, /const VENDOR_HOST = .*\|clerk\|/);
  const config = readFileSync(new URL('../lib/config.mjs', import.meta.url), 'utf8');
  assert.match(config, /https:\/\/identity\.example\.test/);
});
