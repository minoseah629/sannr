// Test-only preload shared by this test file's CLI subprocesses. The first call
// executes npm and retains its actual report/archive; later calls still run the
// product manifest validator and filesystem transaction against those bytes.
// The cache is private to one test process and is never a product feature.
import cp from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.execFileSync;
const fixture = process.env.CI_PACK_FIXTURE;
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (fixture) {
  cp.execFileSync = function(command, args, options) {
    if (command !== 'npm' || args.length !== 6 || args[0] !== 'pack'
      || args[2] !== '--ignore-scripts' || args[3] !== '--json' || args[4] !== '--pack-destination')
      return original.call(this, command, args, options);
    // Keep the actual missing-package-manager failure specimen executable.
    const search = (options?.env ?? process.env).PATH ?? '';
    if (!search.split(delimiter).some(dir => existsSync(join(dir, 'npm')) || existsSync(join(dir, 'npm.cmd'))))
      return original.call(this, command, args, options);
    const receipt = join(fixture, 'receipt.json');
    const destination = args[args.indexOf('--pack-destination') + 1];
    if (!existsSync(receipt)) {
      const output = original.call(this, command, args, options);
      appendFileSync(join(fixture, 'executions'), 'pack\n');
      const report = JSON.parse(output);
      const hashes = Object.fromEntries(report[0].files.map(({ path }) => [path, sha(join(args[1], path))]));
      copyFileSync(join(destination, report[0].filename), join(fixture, 'engine.tgz'));
      writeFileSync(receipt, JSON.stringify({ output, hashes }));
      return output;
    }
    const { output, hashes } = JSON.parse(readFileSync(receipt, 'utf8'));
    for (const [path, expected] of Object.entries(hashes)) {
      if (sha(join(args[1], path)) !== expected) throw new Error('Shared pack fixture source identity changed');
    }
    copyFileSync(join(fixture, 'engine.tgz'), join(destination, JSON.parse(output)[0].filename));
    return output;
  };
  syncBuiltinESMExports();
}
