// Private, request-local execution context. JSON/MCP arguments cannot activate
// it. Saved requests use it to redact explicitly sensitive runtime bindings and
// to require an independent engine dispatch/receipt for each invocation.
import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage();
export const privateRequestInputs = () => context.getStore() ?? null;
export const withPrivateRequestInputs = (values, action) => context.run({ values }, action);
