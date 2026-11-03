import { basename, dirname, resolve } from 'node:path';
import { CLI_NAME } from './brand.mjs';
import { safeOutputPath } from './output-path.mjs';
import { savedRequestAction, savedActionFailure } from './saved-request-actions.mjs';
import { openEvidenceRoot, readEvidenceBytes } from './note-evidence.mjs';

export const savedRequestHelp = () => `\nUsage:
  ${CLI_NAME} saved list [--stack NAME] [--env NAME] [--operation "GET /path"]
  ${CLI_NAME} saved show REF
  ${CLI_NAME} saved create --file DOCUMENT.json     # '-' reads stdin
  ${CLI_NAME} saved edit REF --file DOCUMENT.json
  ${CLI_NAME} saved run REF [--inputs-file PRIVATE.json | --inputs-stdin]
  ${CLI_NAME} saved rename REF --folder FOLDER --name NAME
  ${CLI_NAME} saved delete REF
  ${CLI_NAME} saved reopen RUN_ID --stack NAME
  ${CLI_NAME} saved inspect RUN_ID --stack NAME  # bounded redacted local response

All results are JSON. Opening, saving, listing and reopening send nothing.
Runs use current policy/credentials and produce new evidence. No assertions
means unasserted HTTP outcome, not a passed test. Keep sensitive input values
out of command arguments. Use stdin, a private input file or declared env references.
Delete/rename never deletes execution history. Docs: docs/saved-requests.md`;

const refuse = () => { throw Object.assign(new Error('Invalid arguments'), { code: 'SAVED_ARGUMENT_INVALID' }); };
async function boundedStdin(maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) refuse();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const boundedJson = async file => {
  // Descriptor-bounded regular file reads; symlinks and FIFOs never become
  // an unbounded CLI input. This file capability is not exposed to browsers.
  let text;
  if (file === '-') text = await boundedStdin(128 * 1024);
  else {
    const path = resolve(file); safeOutputPath(path);
    const opened = openEvidenceRoot(dirname(path)); if (!opened) refuse();
    text = readEvidenceBytes(opened, basename(path), { maxBytes: 128 * 1024 }).toString('utf8');
  }
  try { return JSON.parse(text); } catch { refuse(); }
};
export async function runSavedRequestCli(root, argv) {
  try {
    const action = argv[0], args = { action };
    let file, inputsStdin = false;
    const values = { '--stack': 'stack', '--env': 'environment', '--operation': 'operation', '--limit': 'limit',
      '--folder': 'folder', '--name': 'name', '--inputs-file': 'inputFile' };
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--json') continue;
      if (arg === '--inputs-stdin') { if (inputsStdin) refuse(); inputsStdin = true; continue; }
      if (arg === '--file') { if (file !== undefined || !argv[i + 1]) refuse(); file = argv[++i]; continue; }
      if (Object.hasOwn(values, arg)) {
        const key = values[arg]; if (args[key] !== undefined || !argv[i + 1]) refuse(); args[key] = argv[++i];
        if (key === 'limit') args.limit = Number(args.limit);
      } else if (!arg.startsWith('-') && args.ref === undefined && args.runId === undefined) args[['reopen', 'inspect'].includes(action) ? 'runId' : 'ref'] = arg;
      else refuse();
    }
    if (inputsStdin && (file === '-' || args.inputFile !== undefined)) refuse();
    if (file !== undefined) args.document = await boundedJson(file);
    if (inputsStdin) args.inputStdin = await boundedStdin(256 * 1024);
    const result = await savedRequestAction(root, args);
    console.log(JSON.stringify(result, null, 2));
    if (result?.ok === false) process.exitCode = result.mode === 'refused' ? 2 : 1;
  } catch (error) { console.log(JSON.stringify(savedActionFailure(error))); process.exitCode = 2; }
}
