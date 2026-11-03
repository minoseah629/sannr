// Values live at invocation time. Shared documents contain only declarations
// and environment-variable references; this module never writes supplied data.
import { execFileSync } from 'node:child_process';
import { resolve, relative, sep, isAbsolute, dirname, basename } from 'node:path';
import { openEvidenceRoot, readEvidenceBytes } from './note-evidence.mjs';
import { safeOutputPath } from './output-path.mjs';

export const INPUT_BYTES = 256 * 1024;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export class SavedRequestError extends Error {
  constructor(code, message, next = 'Repair the saved request or its local input binding, then retry.', input) {
    super(message); this.name = 'SavedRequestError'; this.code = code; this.next = next;
    if (input) { this.input = input; this.details = { input }; }
  }
}
export const isSavedRequestError = error => error instanceof SavedRequestError;
export const savedRequestError = (...args) => new SavedRequestError(...args);
const fail = (...args) => { throw savedRequestError(...args); };

export function parseSavedRequestInputs(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > INPUT_BYTES)
    fail('SAVED_INPUT_LIMIT', 'Runtime inputs exceed the supported byte limit.');
  try {
    const parsed = JSON.parse(text);
    if (!object(parsed)) throw new Error();
    return parsed;
  } catch { fail('SAVED_INPUT_INVALID', 'Runtime inputs must be a JSON object; its values were withheld.'); }
}

export function readSavedRequestInputFile(root, inputFile) {
  if (typeof inputFile !== 'string' || !inputFile || inputFile.includes('\0')) fail('SAVED_INPUT_FILE_INVALID', 'Choose a local gitignored input file.');
  const file = resolve(root, inputFile), rel = relative(resolve(root), file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('SAVED_INPUT_FILE_OUTSIDE_PROJECT', 'Runtime input files must be inside this project.');
  safeOutputPath(file, { code: 'SAVED_INPUT_FILE_UNSAFE' });
  // Existing ignored files that Git tracks are not private. Both checks are
  // necessary: check-ignore --no-index alone would approve a tracked file.
  try {
    const tracked = execFileSync('git', ['ls-files', '--', rel], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (tracked.trim()) throw new Error();
    execFileSync('git', ['check-ignore', '--quiet', '--', rel], { cwd: root, stdio: 'ignore' });
  } catch { fail('SAVED_INPUT_FILE_NOT_PRIVATE', 'Runtime input files must be untracked and ignored by Git.', 'Add the local file to ignore rules, or supply inputs through stdin or environment-variable references.'); }
  try {
    const opened = openEvidenceRoot(dirname(file));
    if (!opened) throw new Error();
    return parseSavedRequestInputs(readEvidenceBytes(opened, basename(file), { maxBytes: INPUT_BYTES }).toString('utf8'));
  } catch (error) {
    if (error.code?.startsWith('SAVED_')) throw error;
    fail('SAVED_INPUT_FILE_UNSAFE', 'The local input file could not be read safely; its content was withheld.');
  }
}

export function inputTypeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return object(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

export function resolveSavedRequestInputs(root, declarations, options = {}) {
  const sources = [options.inputs !== undefined, options.inputFile !== undefined, options.inputStdin !== undefined].filter(Boolean).length;
  if (sources > 1) fail('SAVED_INPUT_SOURCE_CONFLICT', 'Choose one invocation input source.');
  const supplied = options.inputFile !== undefined ? readSavedRequestInputFile(root, options.inputFile)
    : options.inputStdin !== undefined ? parseSavedRequestInputs(options.inputStdin) : options.inputs ?? {};
  if (!object(supplied)) fail('SAVED_INPUT_INVALID', 'Runtime inputs must be a JSON object.');
  if (Buffer.byteLength(JSON.stringify(supplied)) > INPUT_BYTES) fail('SAVED_INPUT_LIMIT', 'Runtime inputs exceed the supported byte limit.');
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(declarations, name)) fail('SAVED_INPUT_UNKNOWN', 'An undeclared runtime input was supplied; its name and value were withheld.');
  const values = Object.create(null), secrets = [];
  let resolvedBytes = 2;
  for (const [name, declaration] of Object.entries(declarations)) {
    let value = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    let fromEnvironment = false;
    if (value === undefined && declaration.source?.env) {
      const raw = process.env[declaration.source.env];
      if (raw !== undefined) {
        fromEnvironment = true;
        if (declaration.type === 'string') value = raw;
        else try { value = JSON.parse(raw); } catch { fail('SAVED_INPUT_TYPE', `Input '${name}' has the wrong declared type.`, 'Repair this input in its local source; values are never shown in this error.', name); }
      }
    }
    if (value === undefined) fail('SAVED_INPUT_MISSING', `Input '${name}' is missing.`, `Provide '${name}' through stdin, a local ignored file, or its declared environment variable.`, name);
    if (!inputTypeMatches(declaration.type, value)) fail('SAVED_INPUT_TYPE', `Input '${name}' must have type ${declaration.type}.`, 'Repair this input in its local source.', name);
    if (typeof value === 'string' && /\x00/.test(value)) fail('SAVED_INPUT_INVALID', `Input '${name}' contains an unsupported control character.`, 'Repair this input in its local source.', name);
    resolvedBytes += Buffer.byteLength(JSON.stringify(name)) + Buffer.byteLength(JSON.stringify(value)) + 2;
    if (resolvedBytes > INPUT_BYTES) fail('SAVED_INPUT_LIMIT', 'Resolved runtime inputs exceed the supported aggregate byte limit.', 'Reduce the local input sizes; values were withheld.');
    values[name] = value;
    // Environment references may point to an opaque process secret whose
    // name the recipe author did not label sensitive. Never read it back.
    if (declaration.sensitive || fromEnvironment) secrets.push(value);
  }
  return { values, secrets };
}
