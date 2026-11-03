import { relative, sep } from 'node:path';
import { ENVELOPE_VERSION, runAssertions } from './assertions.mjs';
import { SECRET_HEADERS, CREDENTIAL_SHAPED_HEADER } from './curl.mjs';
import { BUILTIN_DEFAULTS } from './config.mjs';
import { snapshotProtocolInputs } from './protocol-credentials.mjs';
import { captureOperationContext, queryOperationContext, operationIdentity, operationId, contextShape } from './operation-context.mjs';
import { compactResponseChangeNotice } from './response-change-notice.mjs';
import { protocolPackageRefusal, verifyProtocolPackages } from './protocol-packages.mjs';
import { publicProtocolCode, publicProtocolTargetError } from './protocol-errors.mjs';
import { stacksMigrationCapture } from './stack-migration-state.mjs';
import { stackFactReceiptAfterTrim } from './stack-facts.mjs';
import { sanitizeResponsePresentation, dataSecretsTracker, setDataSecrets } from './response-redaction.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const credentialHeader = name => name.toLowerCase() === 'set-cookie' || SECRET_HEADERS.test(name) || CREDENTIAL_SHAPED_HEADER.test(name);
const headerClause = clause => object(clause) && Object.hasOwn(clause, 'header');

// Absence can only be asserted against an observed header snapshot. A failed
// connection, or a transport with no HTTP header observation, is not {}.
function protocolAssertions(expect, executed) {
  const unavailable = !object(executed.headers) ? (expect ?? []).filter(headerClause) : [];
  const assertions = runAssertions(unavailable.length ? expect.filter(clause => !headerClause(clause)) : expect,
    { status: executed.status, body: executed.body, headers: executed.headers ?? {} });
  if (!unavailable.length) return assertions;
  return { passed: assertions?.passed ?? 0, failed: (assertions?.failed ?? 0) + unavailable.length,
    failures: [...(assertions?.failures ?? []), ...unavailable.map(clause => ({ target: 'header', path: clause.header,
      op: 'unavailable', code: 'PROTOCOL_HEADERS_UNAVAILABLE', expected: null, actual: null }))] };
}

// Assertions use the actual header values in memory. Credential header values
// and cookie values must not leak through a failed assertion or saved evidence.
function safeObservation(executed, assertions, secrets) {
  const extraSecrets = [], headers = executed.headers && { ...executed.headers };
  for (const [name, value] of Object.entries(headers ?? {})) if (credentialHeader(name)) {
    if (typeof value === 'string') {
      extraSecrets.push(value);
      if (/^(?:proxy-)?authorization$/i.test(name)) extraSecrets.push(value.replace(/^\S+\s+/, ''));
      if (/^(?:set-)?cookie$/i.test(name))
        for (const match of value.matchAll(name.toLowerCase() === 'set-cookie'
          ? /(?:^|,\s*)[^=;\s]+=("[^"]*"|[^;,\s]*)/g : /(?:^|;\s*)[^=;\s]+=("[^"]*"|[^;,\s]*)/g))
          if (match[1] && !/^\/?$/.test(match[1])) extraSecrets.push(match[1]);
    }
    headers[name] = '[redacted]';
  }
  if (assertions) for (const failure of assertions.failures)
    if (failure.target === 'header' && typeof failure.path === 'string' && credentialHeader(failure.path)) {
      failure.actual = '[redacted]';
      if (typeof failure.expected === 'string') failure.expected = '[redacted]';
    }
  return { response: { ...executed, ...(headers ? { headers } : {}) },
    secrets: [...secrets, ...extraSecrets.filter(Boolean)] };
}

// Context and full sanitized evidence are already saved before this function.
// Trim presentation only, naming every omitted field. Keep outcomes, assertion
// counts, and an exact operation digest even when a tiny budget needs a floor.
function fitPresentation(result, budget, identityId, dataSecretReceipt) {
  const bytes = () => Buffer.byteLength(JSON.stringify(setDataSecrets(result, dataSecretReceipt)));
  const fits = () => bytes() <= budget * 4;
  if (fits()) return;
  result.presentation = { reason: 'response-budget', omitted: [] };
  const omitted = field => { if (!result.presentation.omitted.includes(field)) result.presentation.omitted.push(field); };
  if (result.data !== null) {
    result.data = null; omitted('data');
    if (result.mode !== 'assert') result.mode = 'summary';
  }
  if (fits()) return;
  if (result.known !== null) {
    const account = result.known.account_facts;
    const receipt = { ...stackFactReceiptAfterTrim(result.known),
      ...(account ? { account_facts: { ...account, records: [], shown: 0, omitted: account.total } } : {}) };
    result.known = Object.keys(receipt).length ? receipt : null; omitted('known');
  }
  if (fits()) return;
  if (result.discovery?.shape) { result.discovery.shape = null; omitted('discovery.shape'); }
  if (fits()) return;
  if (result.headers !== null) { result.headers = null; omitted('headers'); }
  if (fits()) return;
  if (result.protocol.declaration !== null) { result.protocol.declaration = null; omitted('protocol.declaration'); }
  if (fits()) return;
  if (result.context_capture?.identity) {
    const { state, operation_id, observation_id, change_notice } = result.context_capture;
    result.context_capture = { state, operation_id, observation_id,
      ...(change_notice ? { change_notice: compactResponseChangeNotice(change_notice) } : {}) };
    omitted('context_capture.details');
  }
  if (fits()) return;
  if (result.assertions?.failures.length) {
    const original = result.assertions.failures.length;
    for (const failure of result.assertions.failures) if (typeof failure.path !== 'string' || failure.path.length > 128) {
      failure.path = typeof failure.path === 'string' ? `${failure.path.slice(0, 128)}…` : '[omitted]';
      omitted('assertions.failure_paths');
    }
    while (!fits() && result.assertions.failures.length) {
      result.assertions.failures.pop();
      result.assertions.omitted_failures = original - result.assertions.failures.length;
      omitted('assertions.failure_details');
    }
  }
  if (fits()) return;
  result.protocol.identity = { v: 1, id: identityId };
  omitted('protocol.identity_details');
  if (fits()) return;
  if (result.context_capture?.change_notice) {
    result.context_capture.change_notice = compactResponseChangeNotice(result.context_capture.change_notice, { signalOnly: true });
    omitted('context_capture.change_notice.details');
  }
  if (fits()) return;
  // The mandatory outcome/provenance envelope may exceed a caller's budget.
  // Report its measured minimum instead of silently claiming to fit.
  result.budget_min = 0;
  for (let i = 0; i < 4; i++) {
    const minimum = Math.ceil(bytes() / 4);
    if (result.budget_min === minimum) break;
    result.budget_min = minimum;
  }
}

const adapters = {
  graphql: async (args, root) => {
    const { analyzeGraphql, prepareGraphql } = await import('./protocols/graphql.mjs');
    const analysis = await analyzeGraphql(args, { root });
    if (analysis.kind === 'subscription') {
      verifyProtocolPackages('ws');
      const { prepareGraphqlSubscription } = await import('./protocols/websocket.mjs');
      return prepareGraphqlSubscription(args, { root });
    }
    return prepareGraphql(args, { root });
  },
  jsonrpc: async (args, root) => (await import('./protocols/jsonrpc.mjs')).prepareJsonRpc(args, { root }),
  grpc: async (args, root) => (await import('./protocols/grpc.mjs')).prepareGrpc(args, { root }),
  websocket: async (args, root) => (await import('./protocols/websocket.mjs')).prepareWebsocket(args, { root }),
};
const adapterPackages = { graphql: ['graphql'], jsonrpc: [],
  grpc: ['@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs'], websocket: ['ws'] };

export async function protocolRequest(args, runtime) {
  const refuse = (code, message, next) => runtime.errorEnvelope({ id: args.id ?? null, mode: 'refused', code, message, next });
  if (!Object.hasOwn(adapters, args.protocol)) return refuse('PROTOCOL_UNSUPPORTED', 'No execution adapter is installed for this protocol. External observations can still be captured.');
  const snapshot = snapshotProtocolInputs(args);
  if (snapshot.problem === 'CREDENTIAL_IN_REQUEST') return refuse(snapshot.problem,
    'The protocol payload contains a literal credential location, so it was not sent.',
    'Configure authentication with an environment-variable reference and omit credentials from the protocol payload.');
  if (snapshot.problem) return refuse(snapshot.problem, 'The protocol payload must be bounded plain JSON.');
  args = { ...args, ...snapshot.blocks };
  const block = { graphql: 'graphql', jsonrpc: 'rpc', grpc: 'grpc', websocket: 'websocket' }[args.protocol];
  if (['graphql', 'rpc', 'grpc', 'websocket'].some(key => key !== block
    && !(args.protocol === 'graphql' && key === 'websocket') && args[key] !== undefined))
    return refuse('PROTOCOL_INPUT_CONFLICT', 'Only the selected protocol input object may be supplied.');
  for (const key of ['curl', 'method', 'body', 'body_type', 'files', 'save_to', 'paginate', 'wait_for', 'idempotency_key'])
    if (args[key] !== undefined && args[key] !== null) return refuse('PROTOCOL_OPTION_UNSUPPORTED', `${key} is unavailable for protocol requests; use the protocol-specific input.`);
  if (args.expect !== undefined && !Array.isArray(args.expect)) return refuse('PROTOCOL_INPUT_INVALID', 'expect must be an array.');
  const inheritedTimeout = Number.isFinite(runtime.timeoutMs) ? runtime.timeoutMs : BUILTIN_DEFAULTS.timeoutMs;
  const timeout = args.timeout_ms === undefined ? Math.min(300000, Math.max(1, Math.floor(inheritedTimeout))) : args.timeout_ms;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000)
    return refuse('PROTOCOL_TIMEOUT_INVALID', 'timeout_ms must be an integer between 1 and 300000.');
  const controller = new AbortController();
  const cancel = () => controller.abort(args.signal?.reason);
  if (args.signal?.aborted) cancel();
  else args.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException('Protocol deadline exceeded.', 'TimeoutError')); }, timeout);
  let attempts = 0, target, plan, identity, known, executed;
  try {
    // Check before importing an adapter: a missing package must not poison
    // Node's cached module evaluation. Recheck cached adapters on later calls.
    verifyProtocolPackages(...adapterPackages[args.protocol]);
    plan = await adapters[args.protocol]({ ...args, timeout_ms: timeout }, runtime.root);
    const subscription = args.protocol === 'graphql' && plan.declaration?.operationType === 'subscription';
    if (args.protocol === 'graphql' && !subscription && args.websocket !== undefined)
      return refuse('PROTOCOL_INPUT_CONFLICT', 'websocket options are available only for a GraphQL subscription.');
    if (args.expect?.some(headerClause) && (args.protocol === 'grpc' || args.protocol === 'websocket' || subscription))
      return refuse('PROTOCOL_HEADER_ASSERTION_UNSUPPORTED', 'This transport does not expose an HTTP header snapshot; header assertions are unavailable.');
    target = await runtime.prepareTarget(args, { effect: plan.effect, signal: controller.signal });
    if (target.error) return runtime.errorEnvelope({ id: args.id ?? null, mode: 'refused',
      known: runtime.refusedKnown?.(target) ?? null, error: publicProtocolTargetError(target.error) });
    identity = operationIdentity({ ...(runtime.stack ? { stack: runtime.stack } : {}), provider: target.provider, environment: target.environment,
      protocol: args.protocol, operation: plan.operation, endpoint: `${target.url.origin}${target.url.pathname}`,
      contractDigest: plan.contractDigest ?? null });
    known = runtime.contextEnabled === false ? null : queryOperationContext(runtime.root, identity, { maxBytes: Math.min(1048576, Math.max(1000, Math.floor(runtime.budget * 1.2))) });
    if (runtime.contextEnabled !== false) known = runtime.stackKnown?.(known, identity, target) ?? known;
    executed = await runtime.withSlot(target.url, () => plan.execute({ url: target.url, headers: target.headers,
      hasCredentials: target.secrets.length > 0, signal: controller.signal,
      onAttempt: () => { attempts++; args._onAttempt?.(); } }), controller.signal);
  } catch (error) {
    const packageError = protocolPackageRefusal(error);
    if (!attempts && !controller.signal.aborted && packageError)
      return runtime.errorEnvelope({ id: args.id ?? null, mode: 'refused', error: packageError });
    if (!attempts) {
      if (controller.signal.aborted) return refuse(timedOut ? 'PROTOCOL_TIMEOUT' : 'PROTOCOL_CANCELLED', 'The request ended before dispatch.');
      const code = publicProtocolCode(error, 'PROTOCOL_INPUT_INVALID');
      if (code === 'PROTOCOL_PACKAGE_INTEGRITY') return refuse(code,
        'The installed protocol package files differ from the pinned artifact inventory.',
        'Restore the pinned optional package tree from a matching lockfile with npm ci --ignore-scripts.');
      return refuse(code, 'The protocol request could not be prepared. Check the adapter input and local schema.');
    }
    executed = { status: null, ok: false, body: null, outcome: timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'error',
      complete: false, sent: 0, received: 0, error: { code: 'PROTOCOL_TRANSPORT_ERROR', message: 'The transport ended without a complete result.' },
      omissions: ['The transport did not return message counts or a response.'] };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
  // Application failure stays visible even when HTTP is 200 or assertions on
  // an error response pass. Assertions and protocol outcomes are separate facts.
  const assertions = protocolAssertions(args.expect, executed);
  if (timedOut && executed.outcome === 'cancelled') executed.outcome = 'timeout';
  const observation = safeObservation(executed, assertions, target.secrets);
  if (observation.response.error) {
    const code = publicProtocolCode(observation.response.error, 'PROTOCOL_TRANSPORT_ERROR');
    let message = 'The transport ended without a complete result.';
    if (code !== 'PROTOCOL_TRANSPORT_ERROR') {
      try {
        const detail = observation.response.error.message;
        if (typeof detail === 'string') message = detail;
      } catch { /* foreign accessors cannot escape the envelope */ }
    }
    // Never retain the source error: accessors could change after validation.
    observation.response.error = { code, message };
  }
  const clean = runtime.scrub(observation.response, observation.secrets, 'protocolResponse');
  const routing = runtime.scrub({ ...runtime.routingFields, environment:target.environment }, observation.secrets, 'envelope');
  const result = { v: ENVELOPE_VERSION, id: args.id ?? null, status: clean.status ?? null, ...routing,
    ok: clean.ok === true && (!assertions || assertions.failed === 0), mode: assertions ? 'assert' : 'passthrough',
    assertions: runtime.scrub(assertions, observation.secrets, 'assertions'), data: null, discovery: null, headers: clean.headers ?? null,
    contract_delta: null, rate_limit: null, known:runtime.scrub(known, observation.secrets, 'protocolKnown'),
    protocol: { name: args.protocol, identity, effect: plan.effect, outcome: clean.outcome, complete: clean.complete,
      attempts, sent: clean.sent, received: clean.received, status: clean.protocolStatus ?? null, omissions: clean.omissions ?? [],
      declaration: plan.declaration ?? null },
    evidence: null, ...(clean.error ? { error: clean.error } : {}) };
  let evidence;
  try {
    evidence = runtime.writeEvidence(runtime.scrub({ v: 1, identity, request: { graphql: args.graphql, rpc: args.rpc, grpc: args.grpc, websocket: args.websocket },
      response: observation.response, assertions }, observation.secrets, 'protocolEvidence'));
    result.evidence = evidence.id;
  } catch (error) {
    result.evidence_error = { code: publicProtocolCode(error, 'PROTOCOL_EVIDENCE_FAILED'), message: 'The evidence file could not be written.' };
  }
  try {
    if (runtime.contextEnabled === false || args.capture_context === false) {
      result.context_capture = { state: 'disabled', reason: runtime.contextEnabled === false ? 'API_CONTEXT_OFF' : 'request-opt-out' };
    } else {
      const migration = stacksMigrationCapture(runtime.root);
      if (migration) result.context_capture = migration;
      else {
        const evidencePath = evidence ? relative(runtime.root, evidence.path) : null;
        const refs = evidencePath && evidencePath !== '..' && !evidencePath.startsWith(`..${sep}`) ? [{ path: evidencePath }] : [];
        const omissions = [...(clean.omissions ?? []), 'Only bounded request and response structure is committed; payload values remain in private evidence.'];
        if (!refs.length) omissions.push('No project-local evidence reference was available.');
        result.context_capture = captureOperationContext(runtime.root, { identity, source: { tool: 'api_request' }, basis: 'observed',
          outcome: clean.outcome, complete: clean.complete, sent: clean.sent, received: clean.received, attempts,
          request: runtime.scrub(args.graphql?.variables ?? args.rpc?.params ?? args.grpc?.body ?? args.grpc?.messages ?? args.websocket?.send ?? null, observation.secrets),
          response: clean.body, assertions, evidence: refs, omissions, declaration: plan.declaration }, { internal: true });
      }
    }
  } catch (error) {
    result.context_capture = { state: 'failed', code: publicProtocolCode(error, 'CONTEXT_CAPTURE_FAILED'), message: 'The request completed, but its context could not be recorded.' };
  }
  const presentation = args.reveal_secrets === true ? { body: clean.body, assertions: result.assertions }
    : sanitizeResponsePresentation(clean.body, result.assertions);
  result.assertions = presentation.assertions;
  let originalData = null;
  if (!assertions || assertions.failed || !clean.ok) {
    let data = presentation.body;
    originalData = observation.response.body;
    if (Array.isArray(args.fields) && args.fields.length && data && typeof data === 'object') {
      const project = item => item && typeof item === 'object' ? Object.fromEntries(args.fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])) : item;
      data = Array.isArray(data) ? data.map(project) : project(data);
      originalData = Array.isArray(originalData) ? originalData.map(project) : project(originalData);
      result.mode = 'projection';
    }
    const allowance = Math.max(0, runtime.budget * 4 - Buffer.byteLength(JSON.stringify(result)));
    if (Buffer.byteLength(JSON.stringify(data)) <= allowance) result.data = data;
    else { result.mode = 'summary'; result.discovery = { shape: contextShape(clean.body), truncated: true, reason: 'response-budget' }; }
  }
  // Saved capture keeps the actual resolved public scope. Presentation must
  // still scrub configured labels that happen to equal credential values;
  // provider payloads were scrubbed separately and must not be scrubbed twice.
  result.protocol.identity = runtime.scrub(identity, observation.secrets, 'protocolIdentity');
  if (result.context_capture?.identity)
    result.context_capture.identity = runtime.scrub(result.context_capture.identity, observation.secrets, 'protocolIdentity');
  const maskKey = key => presentation.maskKey?.(runtime.scrub(key, observation.secrets)) ?? runtime.scrub(key, observation.secrets);
  const dataSecretReceipt = dataSecretsTracker(originalData, result.data, maskKey);
  setDataSecrets(result, dataSecretReceipt);
  fitPresentation(result, runtime.budget, operationId(identity), dataSecretReceipt);
  setDataSecrets(result, dataSecretReceipt);
  return args._withBody ? { result, body: clean.body } : result;
}
