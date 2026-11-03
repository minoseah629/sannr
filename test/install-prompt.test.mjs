import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readmeInstallExcerpt, syncReadmeInstallPrompt } from '../scripts/sync-install-prompt.mjs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('README quotes the packaged canonical prompt first, omitting only its final site link', () => {
  const source = read('docs/install-prompt.md');
  const readme = read('README.md');
  assert.equal(syncReadmeInstallPrompt(readme, source), readme, 'Regenerate README from the canonical install prompt');
  assert.match(source.trim(), /What it does: https:\/\/sannr\.dev\/install$/);
  const quotation = /^## Tell your coding agent:\n\n((?:>[^\n]*\n)+)/m.exec(readme)?.[1].trimEnd().replace(/^> ?/gm, '');
  assert.equal(quotation, source.trim().replace(/\s+What it does: https:\/\/sannr\.dev\/install$/, ''));
  assert.doesNotMatch(quotation, /sannr\.dev\/install/);
  assert.equal(/^## .+$/m.exec(readme)?.[0], '## Tell your coding agent:');
  assert.match(readme, /\n\n## Or by hand:\n\n```sh\nnpx @sannr\/sannr connect\nnpx @sannr\/sannr doctor\n```/);
  assert.ok(JSON.parse(read('package.json')).files.includes('docs/install-prompt.md'), 'The source prompt must ship in the package');
});

test('a canonical prompt edit updates its README quote without changing neighboring content', () => {
  const source = read('docs/install-prompt.md');
  const readme = read('README.md');
  const edited = source.replace('Install Sannr in this repository.', 'Install Sannr in this project.');
  const updated = syncReadmeInstallPrompt(readme, edited);
  assert.equal(updated, readme.replace('Install Sannr in this repository.', 'Install Sannr in this project.'));
  assert.equal(syncReadmeInstallPrompt(updated, edited), updated);
  assert.throws(() => syncReadmeInstallPrompt(readme + '<!-- install-prompt:begin -->', source), /exactly one/);
  assert.throws(() => readmeInstallExcerpt(source.replace('What it does:', 'More information:')), /What it does/);
});
