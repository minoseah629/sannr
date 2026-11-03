// Assemble a reviewable source tree, never publish it or copy Git history.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_SURFACES } from '../lib/brand.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--out')
    throw new Error('Usage: node scripts/stage-public-source.mjs --out <new-directory>');
  if (git('diff', '--name-only', 'HEAD').length)
    throw new Error('Commit tracked changes before staging a public source candidate.');
  const out = resolve(process.argv[3]);
  if (out === root || out.startsWith(root + '/')) throw new Error('Stage outside the source checkout.');
  const head = git('rev-parse', 'HEAD').toString().trim();
  const entries = git('ls-tree', '-rz', '--full-tree', head).toString().split('\0').filter(Boolean)
    .map(line => { const [metadata, path] = line.split('\t'); return { mode: metadata.split(' ')[0], path }; });
  if (entries.some(row => !['100644', '100755'].includes(row.mode)))
    throw new Error('Source contains a link or submodule; review it before public staging.');
  if (entries.some(row => row.path === 'PUBLIC_SOURCE.json'))
    throw new Error('PUBLIC_SOURCE.json is reserved for generated assembly metadata.');
  const read = path => git('show', `${head}:${path}`);
  const inventory = JSON.parse(read('packaging/public-source-files.json'));
  const approved = new Set(inventory.files);
  const excludedFiles = new Set(inventory.excluded_files ?? []);
  const excludedDirectories = inventory.excluded_directories ?? [];
  const researchPath = path => excludedFiles.has(path) || excludedDirectories.some(prefix => path.startsWith(prefix));
  if (inventory.schema_version !== 2 || excludedDirectories.some(prefix => !prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('..')))
    throw new Error('Public source inventory must declare reviewed relative exclusion directories.');
  if (inventory.files.some(path => researchPath(path)))
    throw new Error('A public source path is also excluded as research.');
  const excluded = [];
  const files = new Map();
  for (const { path, mode } of entries) {
    if (PRIVATE_SURFACES.includes(path) || path === 'BUILD_STATUS.json' || researchPath(path)) {
      excluded.push(path); continue;
    }
    if (!approved.has(path)) throw new Error(`Unreviewed public source path: ${path}`);
    files.set(path, { bytes: read(path), mode: mode === '100755' ? 0o755 : 0o644 });
  }
  for (const path of approved) if (!files.has(path)) throw new Error(`Reviewed public source path is missing: ${path}`);
  const set = (path, text) => files.set(path, { bytes: Buffer.from(text), mode: 0o644 });
  const conventions = read('packaging/CLAUDE.public.md').toString();
  set('CLAUDE.md', conventions); set('AGENTS.md', conventions);
  // The private research commands and the private alpha ZIP builder remain
  // available in the full checkout. Public package scripts must not advertise
  // an omitted research scorer, a research lane whose declared files are
  // absent, or an alpha packer whose script stays private.
  const packageJson = JSON.parse(read('package.json'));
  const researchScripts = { 'test:external': 'node test/external.mjs', 'test:research': 'node scripts/test-unit.mjs --research',
    'pack:alpha': 'node scripts/pack-alpha.mjs' };
  for (const [name, command] of Object.entries(researchScripts)) {
    if (packageJson.scripts?.[name] !== command)
      throw new Error(`The private research command ${name} changed; review the public package transform.`);
    delete packageJson.scripts[name];
  }
  set('package.json', JSON.stringify(packageJson, null, 2) + '\n');
  // The build-status ledger (BUILD_STATUS.json and reports/) is private: it is
  // excluded above and no public replacement is generated. Public release
  // notes are CHANGELOG.md and GitHub Releases.
  const at = new Date().toISOString();
  const manifest = { schema_version: 1, assembled_at: at, implementation_commit: head,
    excluded_count: excluded.length, excluded_paths_sha256: hash(excluded.sort().join('\n')),
    excluded_categories: ['Private planning and evaluation records', 'Research harnesses, fleet, yardstick, and their exclusive scripts/tests/fixtures', 'Private build-status ledger (BUILD_STATUS.json and reports/); no public replacement is generated'],
    transforms: [
      { id: 'public-agent-conventions', inputs: ['packaging/CLAUDE.public.md'], outputs: ['CLAUDE.md', 'AGENTS.md'] },
      { id: 'omit-private-research-command', inputs: ['package.json'], outputs: ['package.json'] },
    ].map(row => ({ ...row, input_sha256: row.inputs.map(path => hash(read(path))), output_sha256: row.outputs.map(path => hash(files.get(path).bytes)) })),
    files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, row]) => ({ path, mode: row.mode.toString(8), sha256: hash(row.bytes) })),
    boundary: 'Local review candidate only. No Git metadata copied and no remote operation executed. Scan and test before owner authorization.' };
  set('PUBLIC_SOURCE.json', JSON.stringify(manifest, null, 2) + '\n');
  mkdirSync(out); // Refuse to overwrite an existing destination.
  for (const [path, { bytes, mode }] of files) {
    const destination = join(out, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { mode, flag: 'wx' });
  }
  console.log(JSON.stringify({ output: out, source_commit: head, files: files.size, excluded: excluded.length,
    manifest_sha256: hash(files.get('PUBLIC_SOURCE.json').bytes), published: false }, null, 2));
} catch (error) { console.error(`Public source staging failed: ${error.message}`); process.exitCode = 1; }
