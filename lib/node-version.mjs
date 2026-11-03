// Startup's only static dependency. Keep this module free of imports, I/O on
// the supported path, and syntax requiring the Node version it diagnoses.
// The test pins this literal to package.json; reading that file on every
// invocation would add filesystem work just to check an in-memory version.
export const MIN_NODE_VERSION = '22.0.0';

export function assertNodeVersion() {
  let running = process.versions.node;
  const override = process.env.API_TEST_NODE_VERSION;
  if (override !== undefined) {
    // Same test-runner boundary as the fleet capacity seam. Empty values are
    // still attempted overrides, and cannot silently turn the check off.
    if (!process.env.NODE_TEST_CONTEXT) {
      console.error('NODE_VERSION_OVERRIDE_FORBIDDEN: API_TEST_NODE_VERSION requires NODE_TEST_CONTEXT.');
      process.exit(1);
    }
    // Never repeat arbitrary environment bytes in a diagnostic. A bounded
    // release version is the only input this test seam needs to represent.
    if (override.length > 32 || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(override)) {
      console.error('NODE_VERSION_OVERRIDE_INVALID: API_TEST_NODE_VERSION must be a release version such as 20.0.0.');
      process.exit(1);
    }
    running = override.replace(/^v/, '');
  }
  if (parseInt(running, 10) < parseInt(MIN_NODE_VERSION, 10)) {
    // A single stderr line keeps stdout clean for MCP and makes this the
    // first diagnosis, before any application imports or command dispatch.
    console.error(`NODE_VERSION_UNSUPPORTED: running Node v${running}; minimum Node v${MIN_NODE_VERSION} is required.`);
    process.exit(1);
  }
}
