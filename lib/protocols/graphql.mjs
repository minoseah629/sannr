import { createHash } from 'node:crypto';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { parse, print, Kind, Lexer, Source, TokenKind, buildASTSchema, buildClientSchema, validate, validateSchema, getVariableValues } from 'graphql';
import { boundResponseJson } from '../response-bounds.mjs';
import { jsonSnapshot, postJson, protocolError } from './http-json.mjs';

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_DOCUMENT_TOKENS = 10000;
const MAX_DOCUMENT_DEPTH = 32;
const MAX_DOCUMENT_ALIASES = 256;
const MAX_SCHEMA_BYTES = 2 * 1024 * 1024;
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code, message) => { throw protocolError(code, message); };

// Lex before parsing so excessive source nesting gets the named depth refusal
// before the parser can exhaust its call stack. This syntax ceiling also bounds
// nested input literals; expanded field depth is checked separately below.
function boundDocumentSyntax(source) {
  const lexer = new Lexer(new Source(source));
  let tokens = 0, nesting = 0;
  for (;;) {
    let kind;
    try { kind = lexer.advance().kind; }
    catch { error('GRAPHQL_DOCUMENT_INVALID', 'GraphQL document is invalid or exceeds the supported parse bound.'); }
    if (kind === TokenKind.EOF) return;
    if (++tokens > MAX_DOCUMENT_TOKENS)
      error('GRAPHQL_DOCUMENT_INVALID', 'GraphQL document is invalid or exceeds the supported parse bound.');
    if ([TokenKind.BRACE_L, TokenKind.BRACKET_L, TokenKind.PAREN_L].includes(kind)) nesting++;
    else if ([TokenKind.BRACE_R, TokenKind.BRACKET_R, TokenKind.PAREN_R].includes(kind)) nesting--;
    if (nesting > MAX_DOCUMENT_DEPTH * 2)
      error('GRAPHQL_DEPTH_LIMIT', 'GraphQL document exceeds the supported syntax nesting bound of 64.');
  }
}

// Summarize each selection set once. Fragment references form a graph: expanding
// their text recursively would turn a small document into exponential work.
// Cached summaries preserve repeated-spread depth and alias costs without that
// expansion. The explicit stack also handles long fragment chains safely.
function boundDocumentSelections(document) {
  const fragments = new Map(), summaries = new Map(), active = new Set();
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
    const name = definition.name.value;
    if (fragments.has(name)) error('GRAPHQL_FRAGMENT_INVALID', 'GraphQL fragments must have distinct names.');
    fragments.set(name, definition.selectionSet);
  }
  let declaredAliases = 0;
  for (const definition of document.definitions) {
    const root = definition.selectionSet;
    if (summaries.has(root)) continue;
    const stack = [{ node: root, index: 0, depth: 0, aliases: 0 }];
    active.add(root);
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.index === frame.node.selections.length) {
        summaries.set(frame.node, { depth: frame.depth, aliases: frame.aliases });
        active.delete(frame.node);
        stack.pop();
        continue;
      }
      const selection = frame.node.selections[frame.index];
      const field = selection.kind === Kind.FIELD;
      const child = selection.kind === Kind.FRAGMENT_SPREAD
        ? fragments.get(selection.name.value) : selection.selectionSet;
      if (selection.kind === Kind.FRAGMENT_SPREAD && !child)
        error('GRAPHQL_FRAGMENT_INVALID', 'GraphQL fragment references must name declared fragments.');
      if (child && !summaries.has(child)) {
        if (active.has(child)) error('GRAPHQL_FRAGMENT_INVALID', 'GraphQL fragments must not contain cycles.');
        active.add(child);
        stack.push({ node: child, index: 0, depth: 0, aliases: 0 });
        continue;
      }
      const summary = summaries.get(child);
      const alias = field && selection.alias ? 1 : 0;
      declaredAliases += alias;
      frame.depth = Math.max(frame.depth, (summary?.depth ?? 0) + Number(field));
      frame.aliases += (summary?.aliases ?? 0) + alias;
      if (frame.depth > MAX_DOCUMENT_DEPTH)
        error('GRAPHQL_DEPTH_LIMIT', 'GraphQL document exceeds the supported expanded field depth of 32.');
      if (frame.aliases > MAX_DOCUMENT_ALIASES || declaredAliases > MAX_DOCUMENT_ALIASES)
        error('GRAPHQL_ALIAS_LIMIT', 'GraphQL document exceeds the supported alias bound of 256.');
      frame.index++;
    }
  }
}

function loadSchema(file, root) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || /^[a-z][a-z\d+.-]*:/i.test(file))
    error('GRAPHQL_SCHEMA_PATH_INVALID', 'GraphQL schema must be a project-relative file.');
  let source;
  try {
    const project = realpathSync(root ?? process.cwd());
    const candidate = resolve(project, file);
    const requested = relative(project, candidate);
    if (requested === '..' || requested.startsWith(`..${sep}`) || isAbsolute(requested))
      error('GRAPHQL_SCHEMA_PATH_INVALID', 'GraphQL schema must stay within the project.');
    const target = realpathSync(candidate);
    const rel = relative(project, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      error('GRAPHQL_SCHEMA_PATH_INVALID', 'GraphQL schema must stay within the project.');
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > MAX_SCHEMA_BYTES) error('GRAPHQL_SCHEMA_LIMIT', 'GraphQL schema exceeds the supported file bound.');
    source = readFileSync(target, 'utf8');
    if (Buffer.byteLength(source) > MAX_SCHEMA_BYTES) error('GRAPHQL_SCHEMA_LIMIT', 'GraphQL schema exceeds the supported file bound.');
  } catch (failure) {
    if (failure?.code?.startsWith('GRAPHQL_')) throw failure;
    error('GRAPHQL_SCHEMA_UNAVAILABLE', 'GraphQL schema file could not be read.');
  }
  try {
    let schema;
    if (source.trimStart().startsWith('{')) {
      const doc = boundResponseJson(JSON.parse(source));
      schema = buildClientSchema(doc.data ?? doc);
    } else schema = buildASTSchema(parse(source, { maxTokens: 50000 }));
    if (validateSchema(schema).length) error('GRAPHQL_SCHEMA_INVALID', 'GraphQL schema is invalid.');
    return { schema, digest: hash(source) };
  } catch (failure) {
    if (failure?.code?.startsWith('GRAPHQL_')) throw failure;
    error('GRAPHQL_SCHEMA_INVALID', 'GraphQL schema is invalid or exceeds the supported parse bound.');
  }
}

// Shared with the graphql-transport-ws adapter. Raw document/variables stay in
// the transient payload; the declaration contains identifiers and types only.
export async function analyzeGraphql(request, { root } = {}) {
  const input = request?.graphql;
  if (!object(input) || typeof input.document !== 'string' || !input.document.trim())
    error('GRAPHQL_DOCUMENT_REQUIRED', 'GraphQL requires an executable document.');
  if (Object.keys(input).some(key => !['document', 'operationName', 'variables', 'schema'].includes(key)))
    error('GRAPHQL_OPTION_UNSUPPORTED', 'GraphQL input contains an unsupported option.');
  if (Buffer.byteLength(input.document) > MAX_DOCUMENT_BYTES)
    error('GRAPHQL_DOCUMENT_LIMIT', 'GraphQL document exceeds the supported byte bound.');
  if (input.operationName !== undefined && (typeof input.operationName !== 'string' || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(input.operationName)))
    error('GRAPHQL_OPERATION_INVALID', 'GraphQL operationName must be a GraphQL name.');
  if (input.variables !== undefined && !object(input.variables))
    error('GRAPHQL_VARIABLES_INVALID', 'GraphQL variables must be a JSON object.');
  boundDocumentSyntax(input.document);
  let document;
  try { document = parse(input.document, { maxTokens: MAX_DOCUMENT_TOKENS }); }
  catch { error('GRAPHQL_DOCUMENT_INVALID', 'GraphQL document is invalid or exceeds the supported parse bound.'); }
  if (document.definitions.some(definition => ![Kind.OPERATION_DEFINITION, Kind.FRAGMENT_DEFINITION].includes(definition.kind)))
    error('GRAPHQL_DOCUMENT_INVALID', 'GraphQL request must contain only executable definitions.');
  const operations = document.definitions.filter(definition => definition.kind === Kind.OPERATION_DEFINITION);
  const names = operations.map(operation => operation.name?.value);
  if (!operations.length || new Set(names).size !== names.length || operations.length > 1 && names.includes(undefined))
    error('GRAPHQL_OPERATION_INVALID', 'GraphQL operation definitions are missing, duplicate or ambiguous.');
  const selected = input.operationName === undefined
    ? operations.length === 1 ? operations[0] : null
    : operations.find(operation => operation.name?.value === input.operationName);
  if (!selected) error('GRAPHQL_OPERATION_REQUIRED', 'Select exactly one declared GraphQL operation by name.');
  boundDocumentSelections(document);
  const variables = input.variables === undefined ? undefined : jsonSnapshot(input.variables, 'GRAPHQL_VARIABLES_INVALID');
  const loaded = input.schema === undefined ? null : loadSchema(input.schema, root);
  if (loaded) {
    let issues;
    try {
      issues = validate(loaded.schema, document);
      if (!issues.length) issues = getVariableValues(loaded.schema, selected.variableDefinitions ?? [], variables ?? {}, { maxErrors: 20 }).errors ?? [];
    } catch { error('GRAPHQL_VALIDATION_FAILED', 'GraphQL document or variables could not be validated against the schema.'); }
    if (issues.length) error('GRAPHQL_VALIDATION_FAILED', 'GraphQL document or variables do not match the schema.');
  }
  const query = print(document);
  const name = selected.name?.value;
  const payload = jsonSnapshot({ query, ...(name ? { operationName: name } : {}), ...(variables !== undefined ? { variables } : {}) }, 'GRAPHQL_INPUT_LIMIT');
  return {
    kind: selected.operation,
    operation: `${selected.operation} ${name ?? '<anonymous>'} ${hash(query)}`,
    effect: selected.operation === 'mutation' ? 'write' : selected.operation === 'query' ? 'read' : 'unknown',
    contractDigest: loaded?.digest ?? null,
    declaration: { operationType: selected.operation, operationName: name ?? null, schemaValidated: Boolean(loaded),
      validationScope: loaded ? 'request-document-and-variables' : 'document-syntax-and-operation-selection', responseValidated: false,
      variables: (selected.variableDefinitions ?? []).map(variable => ({ name: variable.variable.name.value, type: print(variable.type) })) },
    payload,
  };
}

export async function prepareGraphql(request, options = {}) {
  const { kind, payload, ...prepared } = await analyzeGraphql(request, options);
  if (kind === 'subscription') error('GRAPHQL_SUBSCRIPTION_TRANSPORT_REQUIRED', 'GraphQL subscriptions require the subscription transport.');
  return { ...prepared, execute: async options => {
    const response = await postJson(payload, { ...options, accept: 'application/graphql-response+json, application/json' });
    if (!response.complete) return response;
    const body = response.body;
    const invalid = () => ({ ...response, ok: false, outcome: 'incomplete', complete: false,
      error: { code: 'GRAPHQL_RESPONSE_INVALID', message: 'Response is not a complete GraphQL response.' } });
    if (!object(body)) return invalid();
    if (Object.hasOwn(body, 'hasNext') || Object.hasOwn(body, 'incremental'))
      return { ...response, ok: false, outcome: 'incomplete', complete: false,
        error: { code: 'GRAPHQL_INCREMENTAL_UNSUPPORTED', message: 'Incremental GraphQL results require a streaming transport.' } };
    const hasData = Object.hasOwn(body, 'data'), hasErrors = Object.hasOwn(body, 'errors');
    if ((!hasData && !hasErrors) || hasData && body.data !== null && !object(body.data)
      || hasErrors && (!Array.isArray(body.errors) || !body.errors.length || body.errors.some(item => !object(item) || typeof item.message !== 'string'))
      || Object.hasOwn(body, 'extensions') && !object(body.extensions)) return invalid();
    if (hasErrors) return { ...response, ok: false, outcome: hasData && body.data !== null ? 'partial' : 'error',
      protocolStatus: 'GRAPHQL_ERRORS', error: { code: 'GRAPHQL_ERRORS', message: 'GraphQL returned application errors.' } };
    if (!response.ok) return { ...response, error: { code: 'GRAPHQL_HTTP_ERROR', message: 'GraphQL HTTP request was not successful.' } };
    return response;
  } };
}
