// Scoped state is request-local, never a mutation of process.env. Comparing the
// root prevents a consumer's active stack from leaking into a provider lookup.
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
const scopes = new AsyncLocalStorage();
export const currentStackScope = () => scopes.getStore() ?? null;
export const withStackScope = (scope, fn) => scopes.run(scope, fn);
export const activeStackScopeFor = root => {
  const scope = currentStackScope();
  if (!scope) return null;
  if (resolve(scope.root) === resolve(root)) return scope;
  try { return realpathSync(scope.root) === realpathSync(root) ? scope : null; }
  catch { return null; }
};
export const contextFileFor = (root, fallback) => activeStackScopeFor(root)?.contextFile ?? fallback;
export const evidenceDirectoryFor = (root, fallback) => activeStackScopeFor(root)?.evidenceDir ?? fallback;
