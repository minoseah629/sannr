#!/usr/bin/env node
// Keep the launcher parseable on older Node: the application graph (including
// its entry module) is loaded only after the version guard has passed.
import { assertNodeVersion } from '../lib/node-version.mjs';
assertNodeVersion();
// A package-manager launcher must resolve the stdio entry from the exact
// installed package, not persist a path into its disposable execution cache.
// Keep this dispatch ahead of the human CLI graph: stdout is MCP only.
if (process.argv[2] === 'mcp' && process.argv[3] === 'serve') {
  if (process.argv.length !== 4) {
    console.error('MCP stdio mode accepts no additional arguments.');
    process.exitCode = 2;
  } else import('../lib/stdio-server.mjs');
} else {
  await import('../lib/cli-output.mjs');
  await import('./cli-main.mjs');
}
