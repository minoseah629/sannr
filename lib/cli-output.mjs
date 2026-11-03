// Human CLI only. Install before loading modules that may print diagnostics.
// A pipe consumer can quit while requests are still running. Keep the process
// alive long enough to retain their evidence; never turn a lost output stream
// into an unhandled asynchronous error or a successful CLI exit.
import { writeSync } from 'node:fs';

let outputFailed = false;
const seen = new Set();
for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
  stream.on('error', error => {
    outputFailed = true;
    process.exitCode ||= 1;
    if (seen.has(name)) return;
    seen.add(name);
    if (name === 'stderr') return; // There is no remaining diagnostic channel.
    const closed = ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes(error.code);
    const message = JSON.stringify({ error: {
      code: closed ? 'CLI_OUTPUT_CLOSED' : 'CLI_OUTPUT_FAILED',
      stream: name, ...(closed ? { cause: error.code } : {}),
      message: 'Output could not be delivered. Admitted requests finish so their evidence can be retained.',
    } }) + '\n';
    try { writeSync(2, message); } catch { /* stderr may have closed too */ }
  });
}
process.on('beforeExit', () => { if (outputFailed) process.exitCode ||= 1; });
