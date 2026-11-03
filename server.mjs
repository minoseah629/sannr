#!/usr/bin/env node
// Keep the launcher parseable on older Node: the application graph (including
// its entry module) is loaded only after the version guard has passed.
import { assertNodeVersion } from './lib/node-version.mjs';
assertNodeVersion();
import('./lib/stdio-server.mjs');
