// One headless dispatch surface for CLI, MCP and the paired local workbench.
// Inputs stay invocation-local. No action can change process policy or launch a shell.
import { CLI_NAME } from './brand.mjs';
import { isSavedRequestError } from './saved-request-inputs.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error('Saved request action is invalid.'), {
  code, next: `Read ${CLI_NAME} saved --help and provide the documented fields.`,
}); };
const KEYS = {
  draft: ['stack', 'environment', 'operation'], list: ['stack', 'environment', 'operation', 'limit'], show: ['ref'],
  create: ['document'], edit: ['ref', 'document'], run: ['ref', 'document', 'inputs', 'inputFile', 'inputStdin', 'stack', 'environment'],
  rename: ['ref', 'folder', 'name'], delete: ['ref'], reopen: ['runId', 'stack'], inspect: ['runId', 'stack'],
};

export async function savedRequestAction(root, args, { initiator = 'cli.saved', readOnly = false, browser = false } = {}) {
  if (!object(args) || !Object.hasOwn(KEYS, args.action)) fail('SAVED_ACTION_INVALID');
  const { action, ...params } = args;
  if (Object.keys(params).some(key => !KEYS[action].includes(key))) fail('SAVED_ACTION_FIELD_INVALID');
  if (readOnly && !['draft', 'list', 'show', 'reopen', 'inspect'].includes(action)) fail('LIBRARIAN_READ_ONLY');
  // A browser cannot ask for a generic local file read, even after pairing.
  if (browser && ('inputFile' in params || 'inputStdin' in params)) fail('SAVED_ACTION_FIELD_INVALID');
  const api = await import('./saved-requests.mjs');
  switch (action) {
    case 'draft': return api.draftSavedRequest(root, params);
    case 'list': return api.listSavedRequests(root, params);
    case 'show': return api.showSavedRequest(root, params.ref);
    case 'create': return api.saveSavedRequest(root, params.document);
    case 'edit': {
      const previous = api.showSavedRequest(root, params.ref);
      const before = previous.document ?? previous;
      if (params.document?.id !== before.id || params.document?.folder !== before.folder || params.document?.name !== before.name)
        fail('SAVED_EDIT_IDENTITY_MISMATCH');
      return api.saveSavedRequest(root, params.document, { overwrite: true });
    }
    case 'run': {
      if (Boolean(params.ref) === Boolean(params.document)) fail('SAVED_ACTION_INVALID');
      return api.runSavedRequest(root, params.ref ?? params.document, { ...params, initiator });
    }
    case 'rename': return api.renameSavedRequest(root, params.ref, { folder: params.folder, name: params.name });
    case 'delete': return api.deleteSavedRequest(root, params.ref);
    case 'reopen': return api.reopenSavedRequest(root, params);
    case 'inspect': return (await import('./response-inspection.mjs')).inspectRecordedResponse(root, params);
  }
}

export const SAVED_REQUEST_TOOL = {
  name: 'api_saved_requests',
  description: 'Build a value-free draft from current contract fields, list/show portable saved HTTP requests, reopen a private run as a value-free draft, create/edit/rename/delete a saved request, or run one with current typed inputs and policy. Lists are bounded. Opening never sends; runs without assertions are unasserted observations. Credentials use environment references. See docs/saved-requests.md.',
  inputSchema: { type: 'object', required: ['action'], additionalProperties: false, properties: {
    action: { type: 'string', enum: Object.keys(KEYS) }, ref: { type: 'string' },
    document: { type: 'object' }, inputs: { type: 'object' }, stack: { type: 'string' }, environment: { type: 'string' },
    operation: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    folder: { type: 'string' }, name: { type: 'string' }, runId: { type: 'string' },
  } },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

export function savedActionFailure(error) {
  // Engine messages may identify a missing input, but never serialize an unknown exception.
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'SAVED_ACTION_FAILED';
  if (isSavedRequestError(error)) return { ok: false, error: { code, message: error.message, next: error.next, ...(error.details ? { details: error.details } : {}) } };
  return { ok: false, error: { code, next: `Inspect the input declarations and ${CLI_NAME} saved --help; no automatic retry was attempted.` } };
}
