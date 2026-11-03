// The session ledger's one write-side record. A run file exists only when a
// request reached the network, so a refusal, an unresolved placeholder, a
// batch's cleanup phase and what a batch left behind were visible to the agent
// in its envelope and to nobody afterwards. The client writes this small
// private record beside its run files, in the same ignored evidence directory,
// when a batch envelope finishes or when a single call ends without evidence.
//
// It is a projection of the returned envelope, never of the request or the
// response: fixed codes, HTTP methods, stack names, statuses, counts and run
// ids only. Paths, bodies, captures, ids chosen by the caller and messages are
// not copied. Anything that fails its pattern is recorded as null.
import { randomUUID } from 'node:crypto';
import { requestEvidenceOrigin } from './note-evidence.mjs';
import { secretIn } from './verdicts.mjs';

export const ENVELOPE_RECORD_PREFIX = 'envelope-';
export const ENVELOPE_RECORD_ID = /^envelope-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RUN = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const METHOD = /^[A-Z]{1,16}$/;
const STACK = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROTOCOLS = new Set(['http', 'graphql', 'jsonrpc', 'grpc', 'websocket']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pattern = (value, re) => typeof value === 'string' && re.test(value) && !secretIn(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const assertions = value => object(value) && count(value.passed) !== null && count(value.failed) !== null
  ? { passed: value.passed, failed: value.failed } : null;
const protocolOf = input => typeof input?.protocol === 'string' && PROTOCOLS.has(input.protocol) ? input.protocol : 'http';
const methodOf = input => protocolOf(input) === 'http' ? pattern(String(input?.method ?? 'GET').toUpperCase(), METHOD) : null;
const errorCode = result => pattern(result?.error?.code, CODE);

function step(input, result, phase, index) {
  return { phase, index, protocol: protocolOf(input), method: methodOf(input),
    stack: pattern(result?.stack ?? input?.stack, STACK), evidence: pattern(result?.evidence, RUN),
    status: status(result?.status), ok: result?.ok === true, refused: result?.mode === 'refused',
    error: errorCode(result), assertions: assertions(result?.assertions) };
}

/** The record for one finished batch envelope (results zipped with the
 * requests and cleanup steps that produced them), or null when there is none. */
export function batchOutcomeRecord(envelope, result, { initiator, startedAt }) {
  if (!object(result)) return null;
  const requests = Array.isArray(envelope?.requests) ? envelope.requests : [];
  const cleanup = Array.isArray(envelope?.finally) ? envelope.finally : [];
  const results = Array.isArray(result.results) ? result.results : [];
  const finals = Array.isArray(result.finally) ? result.finally : [];
  const refusal = result.attempted === 0 && !results.length && !finals.length ? errorCode(result) : null;
  return base(initiator, startedAt, {
    batch: true, attempted: count(result.attempted), stopped_early: result.stopped_early === true, ok: result.ok === true,
    refusal, error: null, protocol: null, method: null, stack: pattern(envelope?.stack, STACK),
    steps: [...results.map((item, index) => step(requests[index], item, 'requests', index)),
      ...finals.map((item, index) => step(cleanup[index], item, 'finally', index))],
    requests_declared: requests.length, cleanup_declared: cleanup.length,
    left_behind: Array.isArray(result.left_behind) ? result.left_behind.length : null,
  });
}

/** The record for one single call that returned without a run file: a refusal
 * (nothing was sent) or an error before any response was retained. */
export function singleOutcomeRecord(args, returned, { initiator, startedAt }) {
  // Internal body-carrying calls return { result, body }; only the envelope is read.
  const result = object(returned) && object(returned.result) && !Object.hasOwn(returned, 'error') ? returned.result : returned;
  if (!object(result) || result.evidence || !result.error) return null;
  const refused = result.mode === 'refused';
  return base(initiator, startedAt, {
    batch: false, attempted: refused ? 0 : null, stopped_early: false, ok: false,
    refusal: refused ? errorCode(result) ?? 'REFUSED' : null, error: refused ? null : errorCode(result) ?? 'ERROR',
    protocol: protocolOf(args), method: methodOf(args), stack: pattern(result.stack ?? args?.stack, STACK),
    steps: [], requests_declared: 1, cleanup_declared: 0, left_behind: null,
  });
}

function base(initiator, startedAt, fields) {
  const { scope, transport, ...origin } = requestEvidenceOrigin(initiator);
  return { v: 1, kind: 'envelope-outcome', id: `${ENVELOPE_RECORD_PREFIX}${randomUUID()}`, origin,
    started_at: typeof startedAt === 'string' ? startedAt : origin.observed_at, ...fields };
}
