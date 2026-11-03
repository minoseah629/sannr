// Offline literal inventory. Network behavior still requires call-site review:
// computed destinations cannot be exhaustively listed as literal URLs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function scanUrlLiterals(files) {
  const entries = [], inventory = [];
  for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error(`Non-UTF8 package member needs explicit binary review: ${file}`);
    inventory.push({ file, bytes: bytes.length, sha256: sha(bytes) });
    // Keep raw text, including template expressions and punctuation, so no
    // occurrence vanishes through URL parsing or normalization. Bare schemes
    // in regexes/type tests are not URL literals and have no destination.
    const pattern = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`\\]*/g;
    for (const match of text.matchAll(pattern)) {
      const prefix = text.slice(0, match.index);
      entries.push({ file, line: prefix.split('\n').length,
        column: match.index - prefix.lastIndexOf('\n'), offset: match.index,
        literal: match[0], source_line: text.split('\n')[prefix.split('\n').length - 1] });
    }
  }
  return { schema_version: 1,
    scope: 'Every contiguous scheme:// literal occurrence in every UTF-8 regular package member; raw spelling is retained, including templates. This is not a runtime destination allowlist.',
    file_count: inventory.length, occurrence_count: entries.length,
    unique_literal_count: new Set(entries.map(x => x.literal)).size,
    files: inventory, occurrences: entries };
}

export function archiveFiles(archive) {
  const listing = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').filter(Boolean);
  if (listing.some(line => !/^[-d]/.test(line)))
    throw new Error('Non-regular archive member needs explicit review; links are not silently followed.');
  const names = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').filter(Boolean);
  const seen = new Set(), files = new Map();
  for (const member of names) {
    if (!member.startsWith('package/') || member.split('/').some(x => x === '..') || seen.has(member))
      throw new Error('Unsafe or duplicate package archive member.');
    seen.add(member);
    if (member.endsWith('/')) continue;
    files.set(member.slice('package/'.length), execFileSync('tar', ['-xOf', archive, member], { maxBuffer: 32 * 1024 * 1024 }));
  }
  return files;
}

export function candidateFiles(root) {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--offline', '--json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }));
  if (packed.length !== 1 || !Array.isArray(packed[0].files)) throw new Error('Unexpected npm pack manifest.');
  const files = new Map();
  for (const item of packed[0].files) {
    if (item.path.startsWith('/') || item.path.split(/[\\/]/).some(x => !x || x === '.' || x === '..'))
      throw new Error('Unsafe npm pack member.');
    files.set(item.path, readFileSync(resolve(root, item.path)));
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, input, output] = process.argv.slice(2);
  if (!['--archive', '--candidate'].includes(kind) || !input || !output || process.argv.length !== 5)
    throw new Error('Usage: node scripts/audit-package-urls.mjs <--archive archive.tgz|--candidate directory> output.json');
  const source = resolve(input);
  const report = scanUrlLiterals(kind === '--archive' ? archiveFiles(source) : candidateFiles(source));
  report.input = kind === '--archive' ? { kind: 'archive', sha256: sha(readFileSync(source)) } : { kind: 'npm-offline-dry-run-pack-manifest' };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, files: report.file_count, occurrences: report.occurrence_count, unique: report.unique_literal_count }));
}
