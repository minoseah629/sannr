// Empty inventory results should name the scan that actually ran. Keep the
// longer limitations in the shipped discovery guide, not guessed capabilities.
import { CLI_NAME } from './brand.mjs';
import { CONTRACT_CANDIDATES } from './setup-contract.mjs';

const sourceLimits = 'Route signatures and limits: Python app/router decorators (blueprint/bp not detected); Express/Hono/Fastify shorthand; Next handlers; Nest/Spring-style decorators. Not detected: Starlette route tables, Django urlpatterns, aiohttp, Falcon, Litestar bare decorators, raw ASGI dispatch. See docs/discovery.md.';
const workaround = `Save the app's OpenAPI document as openapi.json, or set API_CONTRACT=<file> for ${CLI_NAME} init.`;

export function emptyApiDiscoveryNext() {
  return `Scanned this tree for openapi*/swagger* (.json/.yaml/.yml), including ${CONTRACT_CANDIDATES.join(', ')}, route signatures and outbound API calls. ${sourceLimits} ${workaround}`;
}

export function emptyContractDiscoveryNext({ stack = false } = {}) {
  if (stack) return 'The selected stack has no contract bound; conventional filenames were not searched. ' +
    "Save the app's OpenAPI document as openapi.json and bind its contract in stack.json; API_CONTRACT does not override an explicit stack. " +
    `For map/audit: ${sourceLimits}`;
  return `Contract-only search: ${CONTRACT_CANDIDATES.join(', ')}. init does not scan source. For map/audit: ${sourceLimits} ${workaround}`;
}
