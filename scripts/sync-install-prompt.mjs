// Build-time quotation of the canonical prompt. This is not a product command.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALL_PROMPT_BEGIN = '<!-- install-prompt:begin -->';
export const INSTALL_PROMPT_END = '<!-- install-prompt:end -->';

export function readmeInstallExcerpt(source) {
  // The site version keeps its final information link. The README is already
  // the product explanation, so its quotation omits only that last sentence.
  const prompt = source.trim().replace(/\s+What it does: https?:\/\/\S+\s*$/, '');
  if (!prompt || prompt === source.trim()) throw new Error('The canonical prompt must end with its What it does URL.');
  if (prompt.includes('```')) throw new Error('The canonical prompt cannot contain a code fence.');
  const command = verb => {
    const matches = [...prompt.matchAll(new RegExp('`([^`\\n]+ ' + verb + ')`', 'g'))];
    if (matches.length !== 1) throw new Error(`The canonical prompt must name one ${verb} command.`);
    return matches[0][1];
  };
  const quotation = prompt.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join('\n');
  return `${INSTALL_PROMPT_BEGIN}\n## Tell your coding agent:\n\n${quotation}\n\n## Or by hand:\n\n\`\`\`sh\n${command('connect')}\n${command('doctor')}\n\`\`\`\n${INSTALL_PROMPT_END}`;
}

export function syncReadmeInstallPrompt(readme, source) {
  if (readme.split(INSTALL_PROMPT_BEGIN).length !== 2 || readme.split(INSTALL_PROMPT_END).length !== 2)
    throw new Error('README must contain exactly one managed install-prompt block.');
  const begin = readme.indexOf(INSTALL_PROMPT_BEGIN), end = readme.indexOf(INSTALL_PROMPT_END);
  if (end < begin) throw new Error('README install-prompt markers are reversed.');
  return readme.slice(0, begin) + readmeInstallExcerpt(source) + readme.slice(end + INSTALL_PROMPT_END.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...extra] = process.argv.slice(2);
  if (!['--write', '--check'].includes(mode) || extra.length) {
    console.error('Usage: node scripts/sync-install-prompt.mjs <--write|--check>');
    process.exitCode = 2;
  } else {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const path = join(root, 'README.md');
    const before = readFileSync(path, 'utf8');
    const after = syncReadmeInstallPrompt(before, readFileSync(join(root, 'docs/install-prompt.md'), 'utf8'));
    if (mode === '--write') {
      if (before !== after) writeFileSync(path, after);
    } else if (before !== after) {
      console.error('README install prompt differs from docs/install-prompt.md. Run scripts/sync-install-prompt.mjs --write.');
      process.exitCode = 1;
    }
  }
}
