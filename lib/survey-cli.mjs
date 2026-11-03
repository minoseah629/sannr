// Explicit survey commands only. Snapshot readers never fall back to discovery;
// stdout and exit status are returned so the normal CLI owns process handling.
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { CLI_NAME } from './brand.mjs';
import { resolveOutputPath, safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { canonicalSurveyJson, safeSurveyText, SURVEY_LIMITS } from './survey-model.mjs';
import { renderSurveyDot, renderSurveyHtml } from './survey-render.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const VALUE_FLAGS = new Set(['--file', '--out', '--state-dir', '--stack', '--operation', '--max-bytes', '--format']);
const ALLOWED = {
  generate: new Set(['--out', '--state-dir', '--exclude-env', '--include-fixtures', '--allow-outside-project']),
  status: new Set(['--file', '--state-dir', '--allow-outside-project']),
  query: new Set(['--file', '--state-dir', '--stack', '--operation', '--max-bytes', '--allow-outside-project']),
  render: new Set(['--file', '--out', '--state-dir', '--format', '--allow-outside-project']),
};
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function parse(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) fail('SURVEY_ARGUMENTS');
  const [command, ...rest] = args, allowed = ALLOWED[command];
  if (!allowed) fail('SURVEY_COMMAND_REQUIRED');
  const flags = new Map();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!allowed.has(flag)) fail('SURVEY_UNKNOWN_ARGUMENT');
    if (flags.has(flag)) fail('SURVEY_DUPLICATE_ARGUMENT');
    if (VALUE_FLAGS.has(flag)) {
      const value = rest[++index];
      if (!value || value.startsWith('-')) fail('SURVEY_MISSING_ARGUMENT_VALUE');
      flags.set(flag, value);
    } else flags.set(flag, true);
  }
  if (command === 'render' && !['json', 'dot', 'html'].includes(flags.get('--format'))) fail('SURVEY_FORMAT_REQUIRED');
  if (command === 'query' && !flags.has('--operation')) fail('SURVEY_OPERATION_REQUIRED');
  if (command === 'query' && (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[^\s?#]*$/u.test(flags.get('--operation'))
    || !safeSurveyText(flags.get('--operation')) || flags.has('--stack') && !safeSurveyText(flags.get('--stack')))) fail('SURVEY_OPERATION_REQUIRED');
  const budget = flags.get('--max-bytes');
  if (budget !== undefined && (!/^\d+$/u.test(budget) || !Number.isInteger(Number(budget))
    || Number(budget) < 512 || Number(budget) > SURVEY_LIMITS.queryBytes)) fail('SURVEY_QUERY_BOUNDS');
  return { command, flags };
}

function destination(root, value, allowOutside) {
  return resolveOutputPath(root, resolve(root, value), { allowOutside, fileOnly: true, code: 'SURVEY_OUTPUT_UNSAFE_PATH' });
}

function stateDirectory(root, value, allowOutside) {
  const target = resolve(root, value), inside = target === root || target.startsWith(`${root}${sep}`);
  if (!inside && !allowOutside) fail('OUTPUT_OUTSIDE_PROJECT');
  return safeOutputPath(target, { directory: true, code: 'SURVEY_STATE_UNSAFE_PATH' });
}

function outputLabel(root, path) {
  const local = relative(root, path).split(sep).join('/');
  return local && !local.startsWith('../') && safeSurveyText(local, { path: true }) ? local : '(explicit external output)';
}

const BAD_STATES = new Set(['invalid', 'not-generated', 'not_generated', 'unavailable', 'missing']);
function requireReadable(result) {
  if (result && !BAD_STATES.has(result.state) && result.snapshot?.kind === 'api-survey') return result;
  const absent = ['not-generated', 'not_generated', 'missing'].includes(result?.state);
  const code = result?.diagnostic?.code ?? result?.code;
  fail(absent ? 'SURVEY_NOT_GENERATED' : /^SURVEY_[A-Z0-9_]{1,60}$/u.test(code ?? '') ? code : 'SURVEY_INVALID');
}

function diagnostic(code) {
  const safeCode = /^(?:SURVEY|OUTPUT)_[A-Z0-9_]{1,60}$/u.test(code ?? '') ? code : 'SURVEY_COMMAND_FAILED';
  const missing = safeCode === 'SURVEY_NOT_GENERATED';
  const args = /ARGUMENT|COMMAND_REQUIRED|FORMAT_REQUIRED|OPERATION_REQUIRED|QUERY_BOUNDS/u.test(safeCode);
  const outside = safeCode === 'OUTPUT_OUTSIDE_PROJECT';
  const conflict = safeCode === 'SURVEY_OUTPUT_EXISTS';
  return { code: safeCode, message: missing ? 'No survey snapshot has been generated at the selected input.'
    : args ? 'Invalid survey arguments; no discovery or output was performed.'
      : outside ? 'Output is outside this project and was not written.'
        : conflict ? 'The output already contains different bytes; it was left unchanged.'
          : 'The survey command could not complete safely; no invalid snapshot was substituted.',
  next: missing ? `Run ${CLI_NAME} survey generate explicitly (or use --out for the selected input file).`
    : args ? `Use ${CLI_NAME} survey --help; query requires --operation and render requires --format json, dot or html.`
      : outside ? 'Choose a project-local destination or pass --allow-outside-project for this explicit output.'
        : conflict ? 'Choose a new output file, or remove the previous generated file deliberately before rendering again.'
          : `Check the selected inputs and permissions; use ${CLI_NAME} survey generate explicitly to create a replacement.` };
}

/** Returns { output, exitCode }; injected I/O supports focused no-discovery tests. */
export async function runSurveyCommand(root, args, { io } = {}) {
  try {
    root = resolve(root);
    const { command, flags } = parse(args), allowOutside = flags.has('--allow-outside-project');
    const options = { ...(flags.has('--file') ? { file: resolve(root, flags.get('--file')) } : {}),
      ...(flags.has('--state-dir') ? { stateDir: stateDirectory(root, flags.get('--state-dir'), allowOutside) } : {}),
      allowOutside };
    const out = flags.has('--out') ? destination(root, flags.get('--out'), allowOutside) : undefined;
    if (command === 'render' && out && options.file === out) fail('SURVEY_OUTPUT_INPUT_COLLISION');
    const api = io ?? await import('./survey.mjs');
    if (command === 'generate') {
      const result = await api.generateSurvey(root, { ...options, ...(out ? { out } : {}),
        excludeEnv: flags.has('--exclude-env'), includeFixtures: flags.has('--include-fixtures') });
      if (BAD_STATES.has(result?.state)) fail(result.code ?? 'SURVEY_GENERATE_FAILED');
      const snapshot = result.snapshot;
      canonicalSurveyJson(snapshot);
      const diagnostics = Object.fromEntries(Object.entries(result.diagnostics ?? {}).filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
      return { output: json({ state: result.state, snapshot: snapshot.snapshot,
        ...(result.path ? { output: outputLabel(root, result.path) } : {}),
        nodes: snapshot.nodes.length, relationships: snapshot.relationships.length, unresolved: snapshot.unresolved.length,
        coverage: snapshot.coverage, diagnostics }), exitCode: 0 };
    }
    if (command === 'status') {
      const result = await api.surveyStatus(root, options);
      if (['invalid', 'not-generated', 'not_generated', 'missing'].includes(result?.state)) {
        fail(result.state === 'invalid' ? result.diagnostic?.code ?? result.code ?? 'SURVEY_INVALID' : 'SURVEY_NOT_GENERATED');
      }
      return { output: json(result), exitCode: 0 };
    }
    if (command === 'query') {
      const result = await api.querySurvey(root, { ...options, operation: flags.get('--operation'),
        ...(flags.has('--stack') ? { stack: flags.get('--stack') } : {}),
        ...(flags.has('--max-bytes') ? { maxBytes: Number(flags.get('--max-bytes')) } : {}) });
      if (BAD_STATES.has(result?.state)) fail(result.state === 'invalid' ? result.diagnostic?.code ?? result.code ?? 'SURVEY_INVALID' : 'SURVEY_NOT_GENERATED');
      return { output: JSON.stringify(result), exitCode: 0 };
    }
    const { snapshot, status } = requireReadable(await api.readSurvey(root, options));
    const format = flags.get('--format');
    const bytes = format === 'json' ? canonicalSurveyJson(snapshot)
      : format === 'dot' ? renderSurveyDot(snapshot, { status }) : renderSurveyHtml(snapshot, { status });
    if (!out) return { output: bytes, exitCode: 0 };
    let unchanged = false;
    if (existsSync(out)) {
      if (lstatSync(out).size > Math.max(SURVEY_LIMITS.bytes * 8, Buffer.byteLength(bytes))) fail('SURVEY_OUTPUT_EXISTS');
      if (readFileSync(out, 'utf8') !== bytes) fail('SURVEY_OUTPUT_EXISTS');
      unchanged = true;
    } else writeOutputFileAtomic(out, bytes, { mkdir: true, code: 'SURVEY_OUTPUT_UNSAFE_PATH' });
    await api.registerSurveyRender?.(root, { ...options, out, format });
    return { output: json({ state: unchanged ? 'unchanged' : 'rendered', format, output: outputLabel(root, out),
      snapshot: snapshot.snapshot, nodes: snapshot.nodes.length, relationships: snapshot.relationships.length }), exitCode: 0 };
  } catch (error) { return { output: json(diagnostic(error?.code)), exitCode: 1 }; }
}
