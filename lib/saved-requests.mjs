// Portable, value-free request recipes. Persistence and discovery never send.
// Execution resolves current stack/contract/inputs, then calls the one client.
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, posix, dirname, basename, resolve } from 'node:path';
import { LAYOUT } from './layout.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { openEvidenceRoot, readEvidenceBytes } from './note-evidence.mjs';
import { resolveStack } from './stacks.mjs';
import { withStackScope } from './stack-scope.mjs';
import { readContract, opNode, deref, basePathOf } from './context.mjs';
import { loadHttpContract, routeRequestPath } from './http-operation-context.mjs';
import { parseAuthReference } from './auth-reference.mjs';
import { SECRET_HEADERS, CREDENTIAL_SHAPED_HEADER, SECRET_PARAMS } from './curl.mjs';
import { scanMetadataSecrets, secretIn } from './verdicts.mjs';
import { RUN_ID } from './key-sources.mjs';
import { withPrivateRequestInputs } from './request-private-inputs.mjs';
import { resolveSavedRequestInputs, inputTypeMatches, savedRequestError } from './saved-request-inputs.mjs';

export const SAVED_REQUEST_DIR = LAYOUT.requests;
export const SAVED_REQUEST_VERSION = 1;
export const SAVED_REQUEST_BYTES = 128 * 1024;
const MAX_FILES = 500, MAX_ENTRIES = 2000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const INPUT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const ID = /^req-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (...args) => { throw savedRequestError(...args); };
const plain = x => object(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const keys = (value, allowed) => {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('SAVED_REQUEST_SHAPE', 'The saved request contains unsupported fields.');
};
const name = value => typeof value === 'string' && NAME.test(value) && !secretIn(value);
function folderParts(folder = '') {
  if (typeof folder !== 'string') fail('SAVED_REQUEST_PATH', 'Request folders must be relative directory names.');
  const parts = folder ? folder.split('/') : [];
  if (parts.length > 6 || parts.some(part => !name(part))) fail('SAVED_REQUEST_PATH', 'Request folders use up to six directory names made of letters, digits, dash and underscore.');
  return parts;
}
export function savedRequestRef(document) { return [...folderParts(document.folder), document.name].join('/'); }
function fileFor(root, ref) {
  if (typeof ref !== 'string') fail('SAVED_REQUEST_PATH', 'Use a saved request reference from the listing.');
  const parts = ref.split('/');
  if (!name(parts.pop()) || parts.length > 6 || parts.some(part => !name(part))) fail('SAVED_REQUEST_PATH', 'The saved request reference is invalid.');
  return safeOutputPath(join(resolve(root), SAVED_REQUEST_DIR, `${ref}.json`), { code: 'SAVED_REQUEST_UNSAFE_PATH' });
}
function readDocument(root, ref) {
  const file = fileFor(root, ref);
  try {
    const opened = openEvidenceRoot(dirname(file));
    if (!opened) fail('SAVED_REQUEST_NOT_FOUND', 'The saved request is not available in this clone.');
    return JSON.parse(readEvidenceBytes(opened, basename(file), { maxBytes: SAVED_REQUEST_BYTES }).toString('utf8'));
  } catch (error) {
    if (error.code?.startsWith('SAVED_')) throw error;
    fail(error.code === 'ENOENT' ? 'SAVED_REQUEST_NOT_FOUND' : 'SAVED_REQUEST_UNREADABLE', 'The saved request could not be read safely.');
  }
}
function validateBinding(value, inputs, used, depth = 0) {
  if (depth > 20) fail('SAVED_REQUEST_LIMIT', 'Request structure exceeds the supported nesting depth.');
  if (plain(value) && Object.hasOwn(value, '$input')) {
    keys(value, ['$input']);
    if (!INPUT.test(value.$input ?? '') || !Object.hasOwn(inputs, value.$input)) fail('SAVED_BINDING_UNKNOWN', 'A binding references an undeclared input.');
    used.add(value.$input); return;
  }
  if (plain(value) && Object.hasOwn(value, '$enum')) {
    keys(value, ['$enum']);
    if (value.$enum !== null && !['string', 'number', 'boolean'].includes(typeof value.$enum)) fail('SAVED_LITERAL_REFUSED', 'Only scalar contract enum values may be stored.');
    return;
  }
  if (Array.isArray(value)) { for (const item of value) validateBinding(item, inputs, used, depth + 1); return; }
  if (plain(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!FIELD.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('SAVED_REQUEST_FIELD', 'Request field names must be bounded structural identifiers.');
      validateBinding(child, inputs, used, depth + 1);
    }
    return;
  }
  fail('SAVED_LITERAL_REFUSED', 'Request values must be explicit input bindings or contract enum bindings.', 'Replace the value with {"$input":"declared_name"}; provide its value only at invocation time.');
}

/** Structural validation does not need local values or evidence in a clone. */
export function validateSavedRequest(document) {
  if (Buffer.byteLength(JSON.stringify(document) ?? '') > SAVED_REQUEST_BYTES) fail('SAVED_REQUEST_LIMIT', 'The saved request exceeds its size limit.');
  keys(document, ['kind', 'origin', 'format_version', 'id', 'folder', 'name', 'stack', 'environment', 'request', 'inputs', 'credentials', 'source']);
  if (document.kind !== 'saved-request' || document.format_version !== SAVED_REQUEST_VERSION) fail('SAVED_REQUEST_VERSION_UNSUPPORTED', 'This reader does not support the saved request format version.');
  // Published direct-request readers otherwise interpret a missing path as
  // GET /. This fixed, non-URL origin marker is a deliberate old-reader
  // refusal sentinel. It is consumed here and never forwarded to the engine.
  if (document.origin !== 'saved-request-document') fail('SAVED_REQUEST_FORMAT_GUARD', 'The saved document is missing its older-reader refusal marker.', 'Add the fixed origin marker saved-request-document; do not pass this document to a direct-request reader.');
  if (!ID.test(document.id ?? '') || !name(document.name)) fail('SAVED_REQUEST_IDENTITY', 'A saved request needs a stable request id and a safe name.');
  folderParts(document.folder);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(document.stack ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(document.environment ?? '')) fail('SAVED_REQUEST_SCOPE', 'Choose an explicit stack and environment.');
  keys(document.request, ['method', 'path', 'body_type', 'bindings']);
  const request = document.request;
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) fail('SAVED_REQUEST_METHOD', 'Choose a supported HTTP method.');
  if (typeof request.path !== 'string' || request.path.length > 1024 || !request.path.startsWith('/') || /[?#[\]\\\s%]/u.test(request.path) || request.path.includes('//') || request.path.split('/').some(part => part === '.' || part === '..')) fail('SAVED_REQUEST_PATH', 'Use the canonical contract path without a URL, query, fragment or literal identifier.');
  if (request.body_type !== undefined && !['json', 'form'].includes(request.body_type)) fail('SAVED_REQUEST_BODY_TYPE', 'Saved requests support JSON and form bodies.');
  keys(document.inputs, Object.keys(document.inputs ?? {}));
  if (Object.keys(document.inputs).length > 100) fail('SAVED_REQUEST_LIMIT', 'A saved request may declare at most 100 inputs.');
  for (const [input, declaration] of Object.entries(document.inputs)) {
    if (!INPUT.test(input) || ['__proto__', 'constructor', 'prototype'].includes(input)) fail('SAVED_INPUT_NAME', 'Input names must be structural identifiers.');
    keys(declaration, ['type', 'sensitive', 'source']);
    if (!['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(declaration.type)) fail('SAVED_INPUT_TYPE', `Input '${input}' requires a supported type.`);
    if (declaration.sensitive !== undefined && typeof declaration.sensitive !== 'boolean') fail('SAVED_INPUT_TYPE', `Input '${input}' requires a boolean sensitive declaration.`);
    if (declaration.sensitive && declaration.type !== 'string') fail('SAVED_INPUT_TYPE', `Sensitive input '${input}' must be a string.`, 'Declare sensitive tokens and private text as string inputs. Bind structured data as individual fields.');
    if (declaration.source !== undefined) {
      keys(declaration.source, ['env']);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(declaration.source.env ?? '')) fail('SAVED_INPUT_SOURCE', `Input '${input}' requires an environment-variable reference.`);
      if (declaration.type !== 'string') fail('SAVED_INPUT_SOURCE', `Environment input '${input}' must be a string.`, 'Supply other typed inputs through stdin, an ignored local JSON file, or explicit invocation inputs.');
    }
  }
  keys(request.bindings, ['path', 'query', 'headers', 'body']);
  const used = new Set();
  for (const location of ['path', 'query', 'headers']) {
    const bindings = request.bindings[location] ?? {};
    if (!plain(bindings)) fail('SAVED_BINDING_INVALID', 'Path, query and header bindings must be maps.');
    if (location === 'headers' && new Set(Object.keys(bindings).map(key => key.toLowerCase())).size !== Object.keys(bindings).length) fail('SAVED_HEADER_DUPLICATE', 'Header names must be unique without regard to case.');
    for (const [field, binding] of Object.entries(bindings)) {
      if (!FIELD.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field)) fail('SAVED_REQUEST_FIELD', 'Binding keys must be structural identifiers.');
      if (location === 'headers' && (SECRET_HEADERS.test(field) || CREDENTIAL_SHAPED_HEADER.test(field)) || location === 'query' && SECRET_PARAMS.test(field)) fail('SAVED_CREDENTIAL_BINDING', 'Credentials belong in the current stack authentication reference, never ordinary request inputs.');
      if (location === 'headers' && /^(host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(field)) fail('SAVED_HEADER_REFUSED', 'Transport-routing headers cannot be saved request inputs.');
      if (!plain(binding) || Object.keys(binding).length !== 1 || !('$input' in binding || '$enum' in binding)) fail('SAVED_BINDING_INVALID', 'Path, query and header entries require a single explicit binding.');
      validateBinding(binding, document.inputs, used);
      if (binding.$input && !['string', 'number', 'integer', 'boolean'].includes(document.inputs[binding.$input].type)) fail('SAVED_BINDING_TYPE', 'Path, query and header inputs require scalar types.');
    }
  }
  if (request.bindings.body !== undefined) validateBinding(request.bindings.body, document.inputs, used);
  const placeholders = [...request.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]{0,127})\}/g)].map(match => match[1]);
  if (request.path.replace(/\{[A-Za-z_][A-Za-z0-9_.-]{0,127}\}/g, '').match(/[{}]/)) fail('SAVED_REQUEST_PATH', 'The path contains an unsupported placeholder.');
  for (const field of placeholders) if (!Object.hasOwn(request.bindings.path ?? {}, field)) fail('SAVED_BINDING_MISSING', `Path input '${field}' has no explicit binding.`, 'Bind every path placeholder before saving.');
  if (Object.keys(request.bindings.path ?? {}).some(field => !placeholders.includes(field))) fail('SAVED_BINDING_UNUSED', 'A path binding does not match a placeholder.');
  for (const input of Object.keys(document.inputs)) if (!used.has(input)) fail('SAVED_BINDING_UNUSED', `Input '${input}' is declared but never bound.`);
  if (!Array.isArray(document.credentials) || document.credentials.length > 1 || document.credentials.some(ref => !parseAuthReference(ref))) fail('SAVED_CREDENTIAL_REFERENCE', 'Credentials must contain the stack authentication reference, or be empty for unauthenticated requests.');
  if (document.source !== undefined) {
    keys(document.source, ['run_id', 'request_id']);
    if (document.source.run_id !== undefined && !RUN_ID.test(document.source.run_id)) fail('SAVED_SOURCE_INVALID', 'The source run identity is invalid.');
    if (document.source.request_id !== undefined && !ID.test(document.source.request_id)) fail('SAVED_SOURCE_INVALID', 'The source request identity is invalid.');
  }
  try { scanMetadataSecrets(document, 'SAVED_SECRET_LITERAL'); }
  catch { fail('SAVED_SECRET_LITERAL', 'The saved document contains secret-shaped metadata or literals; values were withheld.'); }
  return document;
}

function currentContract(root, document) {
  const scope = resolveStack(root, { stack: document.stack, environment: document.environment, path: document.request.path });
  if (!scope || scope.builtin) fail('SAVED_STACK_REQUIRED', 'Saved requests require a configured project stack.');
  if (!scope.config.contract) {
    // Without a contract the author supplies the route identity; it is not a
    // verified operation. Literal path identifiers must still be inputs, and
    // no body/query/header enum value can promote without a contract enum.
    if (document.request.path.split('/').filter(Boolean).some(segment => !/^\{[A-Za-z_][A-Za-z0-9_.-]{0,127}\}$/.test(segment) && !/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(segment))) fail('SAVED_REQUEST_PATH', 'Without a contract, static path segments must be structural names; bind identifiers as path inputs.');
    return { scope, contractDoc: {}, contract: null,
      route: { method: document.request.method, path: document.request.path, endpointPath: document.request.path },
      node: {}, parameters: [], bodySchema: undefined, bodyNode: undefined, basis: 'author-declared; contract unavailable' };
  }
  let contractDoc, contract;
  try { contractDoc = readContract(scope.config.contract).doc; contract = loadHttpContract(scope.config.contract, { pathPrefix: scope.config.contractPathPrefix ?? '' }); }
  catch { fail('SAVED_CONTRACT_UNAVAILABLE', 'The current bound contract could not be read.'); }
  const route = contract?.routes.find(item => item.method === document.request.method && item.path === document.request.path);
  if (!route) fail('SAVED_OPERATION_NOT_DECLARED', 'The canonical method/path is not present in the current bound contract.', 'Choose a current declared operation; URL identifiers are runtime inputs.');
  const node = opNode(contractDoc, document.request.method, document.request.path);
  const base = basePathOf(contractDoc), pathKey = base && document.request.path.startsWith(`${base}/`) ? document.request.path.slice(base.length) : document.request.path;
  const item = contractDoc.paths?.[pathKey] ?? {};
  const parameters = [...(item.parameters ?? []), ...(node.parameters ?? [])].map(parameter => deref(contractDoc, parameter));
  const bodyNode = deref(contractDoc, node.requestBody);
  const media = document.request.body_type === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
  const bodySchema = deref(contractDoc, bodyNode?.content?.[media]?.schema ?? parameters.find(parameter => parameter.in === 'body')?.schema);
  return { scope, contractDoc, contract, route, node, parameters, bodyNode, bodySchema, basis: 'current contract declaration' };
}
const structuralField = value => typeof value === 'string' && FIELD.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) && !secretIn(value);
const fieldLabel = parts => parts.every(structuralField) ? parts.join('.') : 'unsupported field';
function missingBinding(parts) {
  const label = fieldLabel(parts);
  fail('SAVED_BINDING_MISSING', `The required field '${label}' has no input.`, 'Add the required field in the request editor, or rebuild the draft from its current contract.');
}

/** Build only structure from the current contract. Examples, defaults,
 * descriptions and credential values are never copied into a draft. */
export function draftSavedRequest(root, { stack, environment, operation } = {}) {
  if (typeof operation !== 'string' || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[^\s]*$/.test(operation))
    fail('SAVED_REQUEST_OPERATION', 'Choose an HTTP method and canonical operation path.');
  const [method, path] = operation.split(' ');
  const scope = resolveStack(root, { stack, environment, path });
  if (!scope || scope.builtin) fail('SAVED_STACK_REQUIRED', 'Saved requests require a configured project stack.');
  const document = { kind: 'saved-request', origin: 'saved-request-document', format_version: SAVED_REQUEST_VERSION,
    id: `req-${randomUUID()}`, folder: 'requests', name: 'new-request', stack: scope.stack, environment: scope.config.name,
    request: { method, path, bindings: { path: {} } }, inputs: {}, credentials: scope.config.auth ? [scope.config.auth] : [] };
  let current = currentContract(root, document);
  const { contractDoc, parameters, bodyNode } = current, fields = [], warnings = [];
  let optional = 0, blocked = false;
  const warn = (label, reason) => {
    blocked = true;
    if (warnings.length < 20) warnings.push({ code: 'SAVED_DRAFT_FIELD_UNSUPPORTED', message: `${label}: ${reason} Use the advanced editor and review the contract before sending.`, blocking: true });
  };
  const scalar = (schema, location, parts) => {
    const label = fieldLabel([location, ...parts]);
    if (label === 'unsupported field') { warn('A contract field', 'Its name cannot be used safely.'); return; }
    schema = deref(contractDoc, schema);
    if (schema && ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'].some(key => Object.hasOwn(schema, key))) { warn(label, 'This schema needs a choice the form cannot make.'); return; }
    const type = schemaType(schema) ?? (location === 'path' ? 'string' : undefined);
    if (!['string', 'number', 'integer', 'boolean', ...(location === 'body' ? ['null'] : [])].includes(type)) { warn(label, 'Automatic fields require a declared scalar type.'); return; }
    if (fields.length >= 100) { warn(label, 'This request exceeds the 100-input form limit.'); return; }
    let choices;
    if (Object.hasOwn(schema ?? {}, 'enum')) {
      const values = schema.enum;
      if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => !inputTypeMatches(type, value) || typeof value === 'string' && value.length > 1024) || Buffer.byteLength(JSON.stringify(values)) > 8192) {
        warn(label, 'Its enum cannot be represented as bounded scalar choices.'); return;
      }
      try { scanMetadataSecrets({ choices: values }, 'SAVED_ENUM_UNSAFE'); }
      catch { warn(label, 'Its enum contains secret-shaped choices; values were withheld.'); return; }
      choices = values.slice();
    }
    let input = [location, ...parts].join('_').replace(/[^A-Za-z0-9_]/g, '_');
    const digest = createHash('sha256').update(JSON.stringify([location, ...parts])).digest('hex').slice(0, 10);
    if (input.length > 64 || Object.hasOwn(document.inputs, input)) input = `${input.slice(0, 53)}_${digest}`;
    const sensitive = type === 'string';
    document.inputs[input] = { type, ...(sensitive ? { sensitive: true } : {}) };
    fields.push({ input, location, path: parts, label, type, required: true, sensitive, ...(choices ? { enum: choices } : {}) });
    return { $input: input };
  };
  const body = (schema, parts = [], depth = 0) => {
    const label = fieldLabel(['body', ...parts]);
    schema = deref(contractDoc, schema);
    if (depth > 12) { warn(label, 'The schema exceeds the form nesting limit.'); return; }
    if (schema && ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'].some(key => Object.hasOwn(schema, key))) { warn(label, 'This schema needs a choice the form cannot make.'); return; }
    if (document.request.body_type === 'form' && ((parts.length === 0 && schemaType(schema) !== 'object') || (parts.length > 0 && ['object', 'array'].includes(schemaType(schema))))) {
      warn(label, 'Form bodies require individual scalar fields.'); return;
    }
    if (schemaType(schema) !== 'object') return scalar(schema, 'body', parts);
    const properties = schema.properties ?? {}, required = Array.isArray(schema.required) ? schema.required : [];
    optional += Object.keys(properties).filter(key => !required.includes(key)).length;
    const result = {};
    for (const key of required) {
      if (!structuralField(key)) { warn('A body field', 'Its name cannot be used safely.'); continue; }
      const value = body(properties[key], [...parts, key], depth + 1);
      if (value !== undefined) result[key] = value;
    }
    return result;
  };
  const placeholders = [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]{0,127})\}/g)].map(match => match[1]);
  const chosen = new Map();
  for (const parameter of parameters) {
    if (['path', 'query', 'header'].includes(parameter?.in)) chosen.set(`${parameter.in}:${parameter.in === 'header' ? parameter.name?.toLowerCase() : parameter.name}`, parameter);
    else if (parameter?.in !== 'body') {
      if (parameter?.required) warn(fieldLabel([parameter.in, parameter.name]), 'This required parameter location is not supported by saved requests.');
      else optional++;
    }
  }
  for (const key of placeholders) if (!chosen.has(`path:${key}`)) chosen.set(`path:${key}`, { in: 'path', name: key, required: true, schema: { type: 'string' } });
  for (const parameter of chosen.values()) {
    const location = parameter.in === 'header' ? 'headers' : parameter.in;
    if (!parameter.required && !(location === 'path' && placeholders.includes(parameter.name))) { optional++; continue; }
    if (location === 'headers' && (SECRET_HEADERS.test(parameter.name) || CREDENTIAL_SHAPED_HEADER.test(parameter.name)) || location === 'query' && SECRET_PARAMS.test(parameter.name)) {
      warn(fieldLabel([location, parameter.name]), 'This credential belongs in stack authentication, not an ordinary input.'); continue;
    }
    if (location === 'headers' && /^(host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(parameter.name)) { warn(fieldLabel([location, parameter.name]), 'Transport-routing headers cannot be form inputs.'); continue; }
    const value = scalar(parameter.schema ?? parameter, location, [parameter.name]);
    if (value !== undefined) (document.request.bindings[location] ??= {})[parameter.name] = value;
  }
  const swaggerBody = parameters.find(parameter => parameter.in === 'body');
  if (bodyNode?.required || swaggerBody?.required) {
    if (bodyNode && !bodyNode.content?.['application/json'] && bodyNode.content?.['application/x-www-form-urlencoded']) {
      document.request.body_type = 'form'; current = currentContract(root, document);
    } else document.request.body_type = 'json';
    const value = body(current.bodySchema);
    if (value !== undefined) document.request.bindings.body = value;
  } else if (bodyNode || swaggerBody) optional++;
  if (optional) warnings.push({ code: 'SAVED_DRAFT_OPTIONAL_OMITTED', message: `${optional} optional contract fields were left out. Add them in the advanced editor if needed.`, blocking: false });
  if (!current.contract) warnings.push({ code: 'SAVED_DRAFT_NO_CONTRACT', message: 'No contract is bound. Only path placeholders were prepared; review required query, header and body fields before sending.', blocking: false });
  // An incomplete draft is useful to inspect, but must never look ready to send.
  try { validateSavedRequest(document); validateAgainstCurrent(root, document); }
  catch (error) { blocked = true; if (warnings.length < 21) warnings.push({ code: 'SAVED_DRAFT_INCOMPLETE', message: 'The generated draft is incomplete. Review its required fields and the current contract before saving or sending.', blocking: true }); }
  return { document, fields, ready: !blocked, basis: current.basis, warnings, traffic: 'none' };
}
function schemaType(schema) { return schema?.type ?? (schema?.properties ? 'object' : undefined); }
function checkBinding(binding, schema, contractDoc, declarations, label, runtimeValues, depth = 0) {
  if (depth > 20) fail('SAVED_CONTRACT_UNSUPPORTED', 'The input schema exceeds supported nesting depth.');
  schema = deref(contractDoc, schema);
  if (schema && ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'].some(key => Object.hasOwn(schema, key))) fail('SAVED_CONTRACT_UNSUPPORTED', 'This request input uses unsupported contract composition.', 'Use an unambiguous supported input schema before saving or sending this request.');
  if (binding?.$input) {
    const type = declarations[binding.$input].type, expected = schemaType(schema);
    if (expected && expected !== type && !(expected === 'number' && type === 'integer')) fail('SAVED_BINDING_TYPE', `Input '${binding.$input}' differs from its current contract type.`);
    if (runtimeValues && schema?.enum && !schema.enum.some(value => JSON.stringify(value) === JSON.stringify(runtimeValues[binding.$input]))) fail('SAVED_INPUT_ENUM', `Input '${binding.$input}' is outside the current contract enum.`, 'Repair this input in its local source.', binding.$input);
    if (runtimeValues && ['object', 'array'].includes(type)) checkRuntimeSchema(runtimeValues[binding.$input], schema, contractDoc, binding.$input);
    return;
  }
  if (binding && Object.hasOwn(binding, '$enum')) {
    if (!Array.isArray(schema?.enum) || !schema.enum.some(value => JSON.stringify(value) === JSON.stringify(binding.$enum))) fail('SAVED_LITERAL_NOT_ENUM', `A stored literal at '${label}' is not an enum in the current contract.`, 'Replace this literal with a typed runtime input.');
    return;
  }
  if (Array.isArray(binding)) {
    if (schemaType(schema) && schemaType(schema) !== 'array') fail('SAVED_BINDING_TYPE', `The structure at '${label}' differs from the current contract.`);
    for (const child of binding) checkBinding(child, schema?.items, contractDoc, declarations, label, runtimeValues, depth + 1);
    return;
  }
  if (object(binding)) {
    if (schemaType(schema) && schemaType(schema) !== 'object') fail('SAVED_BINDING_TYPE', `The structure at '${label}' differs from the current contract.`);
    for (const field of schema?.required ?? []) if (!Object.hasOwn(binding, field)) missingBinding([...label.split('.'), field]);
    for (const [field, child] of Object.entries(binding)) {
      if (schema?.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, field)) fail('SAVED_BINDING_FIELD', 'A body binding contains a field the current contract disallows.', 'Remove the undeclared field or review the current contract.');
      checkBinding(child, schema?.properties?.[field] ?? (object(schema?.additionalProperties) ? schema.additionalProperties : undefined), contractDoc, declarations, `${label}.${field}`, runtimeValues, depth + 1);
    }
  }
}
function checkRuntimeSchema(value, schema, doc, input, depth = 0) {
  if (depth > 20) fail('SAVED_CONTRACT_UNSUPPORTED', 'The runtime input schema exceeds supported nesting depth.');
  if (!schema) return;
  schema = deref(doc, schema);
  if (schema && ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'].some(key => Object.hasOwn(schema, key))) fail('SAVED_CONTRACT_UNSUPPORTED', 'This runtime input uses unsupported contract composition.', 'Use an unambiguous supported input schema before sending this request.');
  if (schema?.type && !inputTypeMatches(schema.type, value)) fail('SAVED_INPUT_TYPE', `Input '${input}' differs from its current contract type.`, 'Repair this input in its local source.', input);
  if (schema?.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail('SAVED_INPUT_ENUM', `Input '${input}' is outside the current contract enum.`, 'Repair this input in its local source.', input);
  if (object(value)) {
    for (const key of schema?.required ?? []) if (!Object.hasOwn(value, key)) fail('SAVED_INPUT_REQUIRED', `Input '${input}' is missing a required body field.`, 'Repair this input in its local source.', input);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key) && schema.additionalProperties === false) fail('SAVED_INPUT_FIELD', `Input '${input}' contains a field the current contract disallows.`, 'Repair this input in its local source.', input);
      checkRuntimeSchema(child, schema?.properties?.[key] ?? (object(schema?.additionalProperties) ? schema.additionalProperties : undefined), doc, input, depth + 1);
    }
  }
  if (Array.isArray(value)) for (const child of value) checkRuntimeSchema(child, schema?.items, doc, input, depth + 1);
}
function validateAgainstCurrent(root, document, runtimeValues) {
  const current = currentContract(root, document), { scope, contractDoc, parameters, bodySchema, bodyNode } = current;
  const configured = scope.config.auth ? [scope.config.auth] : [];
  if (JSON.stringify(document.credentials) !== JSON.stringify(configured)) fail('SAVED_CREDENTIAL_SCOPE_MISMATCH', 'The saved credential reference differs from the current stack environment.', 'Review the current stack authentication reference and update the saved request explicitly.');
  const auth = parseAuthReference(scope.config.auth), credentialVariables = new Set(auth ? ['envVar', 'usernameEnv', 'passwordEnv', 'clientIdEnv', 'clientSecretEnv'].map(key => auth[key]).filter(Boolean) : []);
  if (Object.values(document.inputs).some(input => credentialVariables.has(input.source?.env))) fail('SAVED_CREDENTIAL_BINDING', 'Current credential variables cannot be used as ordinary request inputs.', 'Keep credential resolution in the stack authentication binding.');
  for (const location of ['path', 'query', 'headers']) {
    const parameterIn = location === 'headers' ? 'header' : location, bindings = document.request.bindings[location] ?? {};
    const relevant = parameters.filter(parameter => parameter?.in === parameterIn);
    const lookup = field => relevant.find(parameter => location === 'headers' ? parameter.name.toLowerCase() === field.toLowerCase() : parameter.name === field);
    for (const parameter of relevant) if (parameter.required && !Object.keys(bindings).some(field => location === 'headers' ? field.toLowerCase() === parameter.name.toLowerCase() : field === parameter.name)) missingBinding([location, parameter.name]);
    for (const [field, binding] of Object.entries(bindings)) checkBinding(binding, lookup(field)?.schema ?? lookup(field), contractDoc, document.inputs, `${location}.${field}`, runtimeValues);
  }
  if ((bodyNode?.required || parameters.some(parameter => parameter.in === 'body' && parameter.required)) && document.request.bindings.body === undefined) {
    const fields = Array.isArray(bodySchema?.required) ? bodySchema.required.slice(0, 8).map(field => fieldLabel(['body', field])) : [];
    fail('SAVED_BINDING_MISSING', fields.length ? `This request requires body fields: ${fields.join(', ')}.` : 'This request requires a body.', 'Fill in the required request fields, or rebuild the draft from its current contract.');
  }
  if (document.request.bindings.body !== undefined) checkBinding(document.request.bindings.body, bodySchema, contractDoc, document.inputs, 'body', runtimeValues);
  return current;
}

function normalizeDraft(supplied) {
  if (!plain(supplied)) fail('SAVED_REQUEST_SHAPE', 'A saved request document must be an object.');
  return validateSavedRequest({ ...supplied, kind: supplied.kind ?? 'saved-request', origin: supplied.origin ?? 'saved-request-document', format_version: supplied.format_version ?? SAVED_REQUEST_VERSION, id: supplied.id ?? `req-${randomUUID()}`, folder: supplied.folder ?? '', inputs: supplied.inputs ?? {}, credentials: supplied.credentials ?? [] });
}
export function saveSavedRequest(root, supplied, { overwrite = false } = {}) {
  const document = normalizeDraft(supplied);
  validateAgainstCurrent(root, document);
  const ref = savedRequestRef(document), file = fileFor(root, ref);
  if (existsSync(file)) {
    if (!overwrite) fail('SAVED_REQUEST_EXISTS', 'A request already exists at this reference.', 'Choose another folder/name or explicitly edit the existing request.');
    const previous = showSavedRequest(root, ref).document;
    if (previous.id !== document.id) fail('SAVED_REQUEST_IDENTITY_MISMATCH', 'Editing must preserve the saved request identity.');
  } else if (listSavedRequests(root, { limit: MAX_FILES }).requests.some(item => item.id === document.id)) fail('SAVED_REQUEST_IDENTITY_EXISTS', 'This request identity already exists; use rename to move it.');
  writeOutputFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`, { mkdir: true, code: 'SAVED_REQUEST_UNSAFE_PATH' });
  return { ref, path: posix.join(SAVED_REQUEST_DIR, `${ref}.json`), document };
}
export function showSavedRequest(root, ref) {
  const document = validateSavedRequest(readDocument(root, ref));
  if (savedRequestRef(document) !== ref) fail('SAVED_REQUEST_IDENTITY_MISMATCH', 'The document folder/name differs from its saved reference.');
  let readiness;
  try { const current = validateAgainstCurrent(root, document); readiness = { state: 'inputs_required', inputs: Object.keys(document.inputs), credentials: document.credentials, basis: current.basis }; }
  catch (error) { readiness = { state: 'unavailable', code: error.code ?? 'SAVED_REQUEST_UNAVAILABLE', next: error.next ?? 'Repair the local stack and contract binding.' }; }
  return { ref, path: posix.join(SAVED_REQUEST_DIR, `${ref}.json`), document, readiness };
}
export function listSavedRequests(root, { stack, environment, operation, limit = 100 } = {}) {
  limit = Math.max(0, Math.min(MAX_FILES, Number.isInteger(limit) ? limit : 100));
  const base = join(resolve(root), SAVED_REQUEST_DIR), references = [], issues = [];
  let entries = 0, scanOmitted = false;
  const walk = (folder, prefix, depth) => {
    if (depth > 6 || entries >= MAX_ENTRIES || references.length >= MAX_FILES) { scanOmitted = true; return; }
    try {
      safeOutputPath(folder, { directory: true, code: 'SAVED_REQUEST_UNSAFE_PATH' });
      for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > MAX_ENTRIES || references.length >= MAX_FILES) { scanOmitted = true; break; }
        if (entry.isDirectory() && name(entry.name)) walk(join(folder, entry.name), [...prefix, entry.name], depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.json') && name(entry.name.slice(0, -5))) references.push([...prefix, entry.name.slice(0, -5)].join('/'));
        else if (entry.isSymbolicLink()) issues.push({ code: 'SAVED_REQUEST_UNSAFE_PATH' });
      }
    } catch (error) { if (error.code !== 'ENOENT') issues.push({ code: 'SAVED_REQUEST_UNREADABLE' }); }
  };
  walk(base, [], 0);
  const matching = [];
  for (const ref of references) {
    try {
      const document = validateSavedRequest(readDocument(root, ref));
      if (savedRequestRef(document) !== ref) throw savedRequestError('SAVED_REQUEST_IDENTITY_MISMATCH', 'Saved identity differs.');
      if (stack && document.stack !== stack || environment && document.environment !== environment || operation && `${document.request.method} ${document.request.path}` !== operation) continue;
      matching.push({ ref, id: document.id, name: document.name, folder: document.folder, stack: document.stack, environment: document.environment, operation: `${document.request.method} ${document.request.path}` });
    } catch (error) { issues.push({ code: error.code ?? 'SAVED_REQUEST_UNREADABLE' }); }
  }
  return { requests: matching.slice(0, limit), omitted: matching.length - Math.min(limit, matching.length), scan_omitted: scanOmitted, issues: issues.slice(0, 20), issues_omitted: Math.max(0, issues.length - 20) };
}
export function renameSavedRequest(root, ref, { folder = '', name: newName } = {}) {
  const { document } = showSavedRequest(root, ref), target = validateSavedRequest({ ...document, folder, name: newName });
  const nextRef = savedRequestRef(target), oldFile = fileFor(root, ref), nextFile = fileFor(root, nextRef);
  if (nextRef === ref) return { ref, document };
  if (existsSync(nextFile)) fail('SAVED_REQUEST_EXISTS', 'A request already exists at the destination.');
  // Write the new recipe before removing the old name; no execution evidence
  // is moved or deleted. This also preserves the old document if writing fails.
  writeOutputFileAtomic(nextFile, `${JSON.stringify(target, null, 2)}\n`, { mkdir: true, code: 'SAVED_REQUEST_UNSAFE_PATH' });
  try { safeOutputPath(oldFile, { code: 'SAVED_REQUEST_UNSAFE_PATH' }); unlinkSync(oldFile); }
  catch { fail('SAVED_REQUEST_RENAME_INCOMPLETE', 'The new reference was saved, but the old reference could not be removed.', 'Inspect the saved request listing; execution history remains intact.'); }
  return { ref: nextRef, document: target, history: 'retained' };
}
export function deleteSavedRequest(root, ref) {
  const { document } = showSavedRequest(root, ref); unlinkSync(fileFor(root, ref));
  return { ref, id: document.id, deleted: true, history: 'retained' };
}
function resolveBinding(binding, values) {
  if (binding?.$input) return values[binding.$input];
  if (binding && Object.hasOwn(binding, '$enum')) return binding.$enum;
  if (Array.isArray(binding)) return binding.map(item => resolveBinding(item, values));
  return Object.fromEntries(Object.entries(binding).map(([key, child]) => [key, resolveBinding(child, values)]));
}
function runtimeStructure(value, depth = 0) {
  if (depth > 20) fail('SAVED_INPUT_LIMIT', 'Runtime input structure exceeds the supported nesting depth.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['$file', '__proto__', 'constructor', 'prototype'].includes(key)) fail('SAVED_INPUT_STRUCTURE', 'Runtime input contains an unsupported file or object directive.', 'Supply ordinary JSON data; saved requests never read body-file directives.');
    runtimeStructure(child, depth + 1);
  }
}
export async function runSavedRequest(root, refOrDocument, options = {}) {
  const document = typeof refOrDocument === 'string' ? showSavedRequest(root, refOrDocument).document : normalizeDraft(refOrDocument);
  for (const field of ['stack', 'environment']) if (options[field] !== undefined && options[field] !== document[field]) fail('SAVED_REQUEST_SCOPE_MISMATCH', `The invocation ${field} differs from the saved request.`, 'Open or edit the saved scope explicitly; supplying values never changes the target.');
  const current = validateAgainstCurrent(root, document);
  const { values, secrets } = resolveSavedRequestInputs(root, document.inputs, options);
  runtimeStructure(values);
  validateAgainstCurrent(root, document, values);
  const bindings = document.request.bindings;
  const canonical = current.contract ? routeRequestPath(current.contract, current.scope.config.baseUrl, current.route)
    : `${new URL(current.scope.config.baseUrl).pathname.replace(/\/+$/, '')}${current.route.path}`;
  const pathname = canonical.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = String(resolveBinding(bindings.path[key], values));
    if (!value || value === '.' || value === '..' || /[\x00-\x1f\x7f]/.test(value)) fail('SAVED_INPUT_PATH', 'A path input is empty or contains unsupported path syntax.', 'Repair the path input in its local source.');
    return encodeURIComponent(value);
  });
  const base = new URL(current.scope.config.baseUrl), path = `${base.origin}${pathname}`;
  const headers = Object.fromEntries(Object.entries(bindings.headers ?? {}).map(([key, binding]) => [key, String(resolveBinding(binding, values))]));
  if (Object.values(headers).some(value => /[\r\n\x00]/.test(value))) fail('SAVED_INPUT_HEADER', 'A header input contains unsupported control characters.');
  const request = { method: document.request.method, path, stack: document.stack, environment: document.environment,
    params: Object.fromEntries(Object.entries(bindings.query ?? {}).map(([key, binding]) => [key, resolveBinding(binding, values)])), headers,
    ...(bindings.body !== undefined ? { body: resolveBinding(bindings.body, values), body_type: document.request.body_type ?? 'json' } : {}) };
  if (request.body_type === 'form' && (!plain(request.body) || Object.values(request.body).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) fail('SAVED_INPUT_FORM', 'Form bodies require a map of scalar values.', 'Bind form fields individually; nested JSON requires body_type json.');
  const { apiRequest } = await import('./client.mjs');
  const executionId = `saved-run-${randomUUID()}`;
  const result = await withStackScope(current.scope, () => withPrivateRequestInputs(secrets, () => apiRequest(request, { initiator: options.initiator ?? 'library.apiRequest', requiredAuth: document.credentials[0] ?? 'none' })));
  const receipt = { kind: 'saved-request-execution', format_version: 1, id: executionId, request_id: document.id,
    ref: savedRequestRef(document), stack: document.stack, environment: document.environment,
    operation: `${document.request.method} ${document.request.path}`, executed_at: new Date().toISOString(),
    evidence: result.evidence ?? null, source: document.source ?? null,
    assertions: 'not_run', status: result.status ?? null, refused: result.mode === 'refused', error: result.error?.code ?? null };
  let receiptState = 'recorded';
  try {
    const dir = join(resolve(root), current.scope.evidenceDir);
    safeOutputPath(dir, { directory: true, code: 'SAVED_REQUEST_UNSAFE_PATH' });
    writeOutputFileAtomic(join(dir, '.gitignore'), '*\n', { mkdir: true, mode: 0o600 });
    writeOutputFileAtomic(join(dir, `${executionId}.json`), JSON.stringify(receipt), { mode: 0o600 });
  } catch { receiptState = 'unavailable'; }
  return { ...result, saved_request: { id: document.id, request_id: document.id, run_id: result.evidence ?? null, ref: receipt.ref, execution_id: executionId, source: receipt.source, receipt: receiptState, assertions: 'not_run' } };
}

/** Small operation-context advertisement, without request bodies or inputs. */
export function savedRequestContext(root, { stack, environment, operation, maxBytes = 800, env = process.env } = {}) {
  if (env.API_CONTEXT_OFF === '1' || !stack || !environment || !operation) return null;
  const list = listSavedRequests(root, { stack, environment, operation, limit: 5 });
  if (!list.requests.length && !list.omitted && !list.scan_omitted && !list.issues.length) return null;
  // References already identify the file to open; repeating its UUID in every
  // response spends standing context without adding a discovery action.
  const result = { requests: list.requests.map(({ ref }) => ({ ref })), omitted: list.omitted, ...(list.scan_omitted ? { scan_omitted: true } : {}), ...(list.issues.length ? { unavailable: list.issues.length + list.issues_omitted } : {}) };
  const measure = () => { result.bytes = 0; for (let i = 0; i < 5; i++) result.bytes = Buffer.byteLength(JSON.stringify(result)); };
  measure();
  while (result.bytes > maxBytes && result.requests.length) { result.requests.pop(); result.omitted++; measure(); }
  return result.bytes <= maxBytes ? result : null;
}

/** History becomes a new recipe, never a replay or a copy of private values. */
export function reopenSavedRequest(root, { runId, stack } = {}) {
  if (!RUN_ID.test(runId ?? '') || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(stack ?? '')) fail('SAVED_HISTORY_REFERENCE', 'Choose a recorded run and its stack.');
  let record;
  try {
    const opened = openEvidenceRoot(join(resolve(root), LAYOUT.evidence, stack));
    if (!opened) throw new Error();
    record = JSON.parse(readEvidenceBytes(opened, `${runId}.json`, { maxBytes: 8 * 1024 * 1024 }).toString('utf8'));
  } catch { fail('SAVED_HISTORY_UNAVAILABLE', 'Private source evidence is unavailable in this clone.'); }
  const scope = record.origin?.scope, operation = scope?.operation;
  if (scope?.protocol !== 'http' || typeof operation !== 'string' || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[^?#]*$/.test(operation)) fail('SAVED_HISTORY_SCOPE_UNKNOWN', 'This history record has no safe canonical HTTP operation.', 'Choose a current contract operation and create a new value-free draft.');
  const [method, path] = [operation.slice(0, operation.indexOf(' ')), operation.slice(operation.indexOf(' ') + 1)];
  const draft = { kind: 'saved-request', origin: 'saved-request-document', format_version: 1, id: `req-${randomUUID()}`, name: 'reopened-request', folder: '', stack, environment: scope.environment,
    request: { method, path, bindings: { path: {}, query: {}, headers: {} } }, inputs: {}, credentials: [], source: { run_id: runId } };
  let current;
  try { current = currentContract(root, draft); } catch (error) { throw error; }
  draft.credentials = current.scope.config.auth ? [current.scope.config.auth] : [];
  const missing = [], used = new Set();
  const bind = (field, schema, location) => {
    let input = `${location}_${field}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 55) || 'input';
    let suffix = 1; while (used.has(input)) input = `${input.slice(0, 55)}_${suffix++}`;
    used.add(input);
    schema = deref(current.contractDoc, schema);
    const type = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(schemaType(schema)) ? schemaType(schema) : 'string';
    draft.inputs[input] = { type, ...(type === 'string' ? { sensitive: true } : {}) };
    missing.push(input); return { $input: input };
  };
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const parameter = current.parameters.find(item => item.in === 'path' && item.name === match[1]);
    draft.request.bindings.path[match[1]] = bind(match[1], parameter?.schema ?? parameter, 'path');
  }
  // Only contract-declared field names cross from history. Private URL values,
  // arbitrary header names and recorded body strings are never projected.
  let queryNames = new Set(); try { queryNames = new Set(new URL(record.request?.url).searchParams.keys()); } catch {}
  const historyHeaders = new Set(Object.keys(record.request?.headers ?? {}).map(field => field.toLowerCase()));
  for (const parameter of current.parameters) {
    const location = parameter.in === 'query' ? 'query' : parameter.in === 'header' ? 'headers' : null;
    if (!location || !FIELD.test(parameter.name ?? '')) continue;
    if (location === 'headers' && (SECRET_HEADERS.test(parameter.name) || CREDENTIAL_SHAPED_HEADER.test(parameter.name)) || location === 'query' && SECRET_PARAMS.test(parameter.name)) continue;
    if (parameter.required || (location === 'query' ? queryNames.has(parameter.name) : historyHeaders.has(parameter.name.toLowerCase()))) draft.request.bindings[location][parameter.name] = bind(parameter.name, parameter.schema ?? parameter, location);
  }
  if (current.bodyNode?.required || record.request?.body !== null && record.request?.body !== undefined) draft.request.bindings.body = bind('body', current.bodySchema, 'body');
  validateSavedRequest(draft);
  return { document: draft, missing_inputs: missing, withheld: ['historical values', 'historical authorization', 'undeclared fields'], assertions: 'not_run', traffic: 'none' };
}
