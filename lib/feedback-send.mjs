// Explicit-send preparation only. All network I/O stays in the API client.
import { mkdirSync, readFileSync, rmdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, posix } from 'node:path';
import { FEEDBACK_SEND_ENV, FEEDBACK_ORIGIN } from './brand.mjs';
import { LAYOUT } from './layout.mjs';
import { stackCatalog } from './stacks.mjs';
import { machineStatePaths } from './machine-state.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { encodeFeedbackPayload } from './feedback-payload.mjs';

export const FEEDBACK_COOLDOWN_MS = 30_000;
export const FEEDBACK_RECEIPTS_DIRECTORY = posix.join(LAYOUT.directory, 'feedback', 'sent');
export const FEEDBACK_COOLDOWN_BASENAME = 'feedback-send.json';
export const FEEDBACK_LOCK_BASENAME = '.feedback-send.lock';
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) }); };
export function feedbackSendPolicy(root, env = process.env) {
  const catalog = stackCatalog(root);
  if (catalog.problems.length) fail('FEEDBACK_POLICY_INVALID', 'Repository configuration must be valid before feedback can be sent.');
  const configured = catalog.defaults.feedback?.send ?? 'ask';
  const override = env[FEEDBACK_SEND_ENV];
  if (configured === 'never' || override === 'never') return 'never';
  if (override !== undefined && !['ask', 'allow'].includes(override))
    fail('FEEDBACK_POLICY_INVALID', 'The feedback send setting must be ask, allow or never.');
  return override ?? configured;
}
function ulid(now) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = BigInt(now), stamp = '', entropy = BigInt(`0x${randomBytes(10).toString('hex')}`), suffix = '';
  for (let i = 0; i < 10; i++) { stamp = alphabet[Number(time & 31n)] + stamp; time >>= 5n; }
  for (let i = 0; i < 16; i++) { suffix = alphabet[Number(entropy & 31n)] + suffix; entropy >>= 5n; }
  return stamp + suffix;
}
function privateDirectory(path) {
  safeOutputPath(path, { directory: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** No network occurs until the exact serialized body exists privately. The
 * cooldown reservation is atomic across processes, including different repos.
 * An ambiguous transport failure keeps the reservation: never retry a POST. */
export async function prepareFeedbackSend(root, input, { confirmed = false, disclose } = {}) {
  const policy = feedbackSendPolicy(root);
  if (policy === 'never') fail('FEEDBACK_SEND_DISABLED', 'Feedback sending is disabled; nothing was sent.');
  const { payload, bytes } = encodeFeedbackPayload(input, { forbiddenNames: [basename(root)] });
  const directory = dirname(join(root, FEEDBACK_RECEIPTS_DIRECTORY));
  privateDirectory(directory);
  writeOutputFileAtomic(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
  privateDirectory(join(directory, 'sent'));
  const receipt = join(directory, 'sent', `${ulid(Date.now())}.json`);
  writeOutputFileAtomic(receipt, bytes, { mode: 0o600 });
  if (policy === 'ask' && !confirmed)
    fail('FEEDBACK_SEND_CONFIRMATION_REQUIRED', 'The human must confirm this send in the current session. Review the local receipt, then use feedback --send --confirm-send only after that yes.', { receipt });
  const message = `Sending the anonymized feedback report, your feedback text and optional score to ${FEEDBACK_ORIGIN}/api/v1/feedback; the exact body is saved locally.`;
  // MCP has no ordinary stdout channel (stdio is its protocol). The CLI and
  // default stderr callback both disclose before the transport is invoked.
  await (disclose ?? (text => new Promise((resolve, reject) => process.stderr.write(`${text}\n`, error => error ? reject(error) : resolve()))))(message);
  const state = machineStatePaths().directory;
  privateDirectory(state);
  const lock = join(state, FEEDBACK_LOCK_BASENAME);
  safeOutputPath(lock, { directory: true });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('FEEDBACK_SEND_BUSY', 'Another feedback send is being prepared; nothing was sent. Retry after 30 seconds. If its process ended unexpectedly, inspect and remove the local feedback lock.',
      { retry_after_ms: FEEDBACK_COOLDOWN_MS, retry_at: new Date(Date.now() + FEEDBACK_COOLDOWN_MS).toISOString() });
    throw error;
  }
  try {
    const path = safeOutputPath(join(state, FEEDBACK_COOLDOWN_BASENAME));
    let last = null;
    try { last = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') fail('FEEDBACK_RATE_STATE_INVALID', 'The local feedback cooldown record needs inspection; nothing was sent.'); }
    if (last !== null && (!Number.isSafeInteger(last.attempted_at) || last.attempted_at < 0))
      fail('FEEDBACK_RATE_STATE_INVALID', 'The local feedback cooldown record needs inspection; nothing was sent.');
    const now = Date.now(), retryAt = (last?.attempted_at ?? 0) + FEEDBACK_COOLDOWN_MS;
    if (last && retryAt > now) fail('FEEDBACK_RATE_LIMITED', 'Feedback was sent or attempted less than 30 seconds ago; nothing was sent.',
      { retry_after_ms: retryAt - now, retry_at: new Date(retryAt).toISOString(), receipt });
    writeOutputFileAtomic(path, JSON.stringify({ attempted_at: now }) + '\n', { mode: 0o600 });
  } finally { rmdirSync(lock); }
  return { payload: JSON.parse(bytes.toString('utf8')), bytes, receipt, policy };
}
