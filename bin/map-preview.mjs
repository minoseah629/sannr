// Private worker: the CLI supplies generated HTML over IPC, never a file path.
import { createMapPreview } from '../lib/map-preview.mjs';

let preview, ready = false;
const shutdown = async () => {
  clearTimeout(initialization);
  if (preview) await preview.close();
  process.exit(0);
};
const initialization = setTimeout(shutdown, 5000);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', () => { if (!ready) void shutdown(); });
process.once('message', async message => {
  if (message?.type !== 'init') { void shutdown(); return; }
  try {
    preview = await createMapPreview(message.html);
    ready = true;
    clearTimeout(initialization);
    process.send({ type: 'ready', url: preview.url }, error => { if (error) void shutdown(); });
    await preview.closed;
    process.exit(0);
  } catch {
    if (process.connected) process.send({ type: 'error' }, () => { void shutdown(); });
    else void shutdown();
  }
});
