import { parseAuthReference, basicAuthValueProblem } from './auth-reference.mjs';
// Named environments. A large org's dev, staging, and prod are not the same API:
// different base URL, different credentials, and often genuinely different
// behaviour. Without this the client points at one of them and reports every
// difference in the others as contract drift, which is a confident false alarm.
//
// Config file (searched from cwd upward): api-environments.json, or $API_CONFIG.
//
//   { "v": 1,
//     "default": "local",
//     "environments": {
//       "local":   { "baseUrl": "http://127.0.0.1:8787",
//                    "contract": "./openapi.json",
//                    "auth": "header:X-API-Key:EDITORIAL_API_KEY",
//                    "envFile": "~/.config/example/api.env",
//                    "variables": { "orgId": "1" } },
//       "staging": { "baseUrl": "https://staging.example.test",
//                    "contract": "./openapi.staging.json",
//                    "auth": "bearer:STAGING_TOKEN" },
//       "prod":    { "baseUrl": "https://api.example.test",
//                    "auth": "bearer:PROD_TOKEN",
//                    "production": true } },
//     "hosts": {
//       "billing": { "baseUrl": "https://billing.example.test", "auth": "bearer:BILLING_KEY",
//                    "contract": "./contracts/billing.openapi.json" },
//       "identity": { "baseUrl": "https://identity.example.test", "auth": "header:X-API-Key:IDENTITY_KEY" } } }
//
// `hosts` is the multi-credential half (F1): named upstreams, each with its own
// base URL and its own credential reference, so an agent wiring up several
// authenticated vendors runs ONE client instead of one per vendor. It can live
// at the top level (shared by every environment) or inside an environment
// (scoped to it); the environment's entry wins per name. The single `auth`
// field keeps meaning "the credential for the base URL" — untouched.
//
// Secrets are still referenced by environment-variable NAME. A config file that
// contains a credential is a config file that ends up in git.

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";
import { homedir } from "node:os";
import { LAYOUT } from "./layout.mjs";
import { secretIn } from "./verdicts.mjs";
import { currentStackScope, activeStackScopeFor } from "./stack-scope.mjs";
import { stackCatalog, resolveStack, stackProjectRoot, isBuiltinStack, isBuiltinFeedbackTarget } from "./stacks.mjs";

const CONFIG_NAMES = [LAYOUT.environments];
const scopeMatches = (scope, cwd, automatic) => {
  if (!scope?.config) return false;
  if (activeStackScopeFor(cwd) === scope) return true;
  const part = relative(resolve(scope.root), resolve(cwd));
  return automatic || part === "" || part !== ".." && !part.startsWith(`..${sep}`);
};
const stackStart = (cwd, automatic) => automatic ? process.env.API_CONTEXT_DIR ?? process.env.API_REPO_ROOT ?? cwd : cwd;

const expand = (p) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function findConfigFile(startDir) {
  if (process.env.API_CONFIG) {
    const explicit = resolve(expand(process.env.API_CONFIG));
    return existsSync(explicit) ? explicit : { missing: explicit };
  }
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Only values installed by this module are file-owned. A value inherited from
// the parent process, or explicitly replaced later, always wins over a file.
const fileOwnedEnvironment = new Map();

function readEnvFile(path) {
  const values = Object.create(null);
  if (!path) return values;
  try {
    for (const line of readFileSync(expand(path), "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, k, raw] = m;
      if (!Object.hasOwn(values, k)) values[k] = raw.replace(/^['"]|['"]$/g, "");
    }
  } catch { /* absent or unreadable; the auth path reports precisely what is missing */ }
  return values;
}

function releaseFileEnvironment(path) {
  for (const [key, owned] of fileOwnedEnvironment) {
    if (path !== undefined && owned.path !== path) continue;
    if (process.env[key] === owned.value) delete process.env[key];
    fileOwnedEnvironment.delete(key);
  }
}

// KEY=VALUE file, used for credentials an MCP host cannot supply because it
// does not run a login shell. Re-reading replaces only this file's own values;
// removed or unreadable values are withdrawn rather than retained indefinitely.
export function loadEnvFile(path) {
  if (!path) return;
  const absolute = resolve(expand(path));
  releaseFileEnvironment(absolute);
  for (const [key, value] of Object.entries(readEnvFile(absolute))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    fileOwnedEnvironment.set(key, { path: absolute, value });
  }
}

// A credential snapshot is provider-local and read at dispatch, including in a
// long-lived MCP process. Never merge another provider's startup env-file values
// into it. It is passed through async OAuth work unchanged, so concurrent hosts
// cannot replace one another's credentials between a grant and its request.
export function credentialEnvironment(paths = []) {
  const values = Object.create(null);
  for (const path of paths) {
    for (const [key, value] of Object.entries(readEnvFile(path))) {
      if (!Object.hasOwn(values, key)) values[key] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    const owned = fileOwnedEnvironment.get(key);
    if (owned && owned.value === value) continue;
    if (owned) fileOwnedEnvironment.delete(key);
    values[key] = value;
  }
  return values;
}

// Where requests go when NOBODY has said where requests go. A plain localhost
// URL on purpose (it fails closed, against a machine the user controls), and
// NAMED rather than inlined so `doctor` can tell "the user configured this
// address" from "nobody configured anything" — which read identically while
// the value was a literal buried in the resolver.
export const FALLBACK_BASE_URL = "http://127.0.0.1:8000";

// Built-in client defaults — the values that apply when neither an environment
// variable nor the config file's `defaults` block says otherwise. One table so
// the readers (client.mjs, context.mjs), `doctor`, and `--help` can never
// disagree about what "default" means.
export { BUILTIN_DEFAULTS, resolveDefaults } from "./config-defaults.mjs";
import { BUILTIN_DEFAULTS, resolveDefaults } from "./config-defaults.mjs";

// The defaults alone, resolved by finding and parsing the config file WITHOUT
// selecting an environment or loading any env file. context.mjs needs the
// stale-days horizon but must not trigger credential side effects to get it; a
// malformed or absent file simply yields the env-or-built-in answer.
export function readConfigDefaults(cwd = process.cwd()) {
  const active = currentStackScope();
  if (scopeMatches(active, cwd, arguments.length === 0)) return active.config.defaults;
  const root = stackProjectRoot(stackStart(cwd, arguments.length === 0)), catalog = stackCatalog(root);
  if (catalog.stacks.length) return resolveDefaults(catalog.defaults);
  const found = findConfigFile(cwd);
  let fileDefaults = readStandaloneDefaults(cwd);
  if (found && !found.missing) {
    try { fileDefaults = { ...fileDefaults, ...JSON.parse(readFileSync(found, "utf8"))?.defaults }; }
    catch { /* invalid JSON is reported by resolveConfig; defaults fall through */ }
  }
  return resolveDefaults(fileDefaults);
}
export function projectConfigRoot(file) {
  if (file?.endsWith("/stack.json")) {
    const catalogRoot = resolve(file, "../../../..");
    if (stackCatalog(catalogRoot).stacks.some(row => row.file === resolve(file))) return catalogRoot;
  }
  const normalized = file.replaceAll('\\', '/');
  return normalized.endsWith('/' + LAYOUT.environments)
    ? resolve(file, ...LAYOUT.environments.split('/').map(() => '..')) : dirname(file);
}
function readStandaloneDefaults(cwd) {
  let root = resolve(cwd);
  for (;;) {
    const file = join(root, LAYOUT.defaults);
    try { const value = JSON.parse(readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { /* optional defaults; explicit config validation remains separate */ }
    const parent = dirname(root); if (parent === root) return {}; root = parent;
  }
}

// The credential env-var name(s) an auth spec references, for callers that need
// to check they are SET without wiring up the full request path (doctor). The
// spec forms mirror client.mjs's parseAuth: bearer:ENV, header:Name:ENV,
// query:param:ENV, oauth:CLIENT_ID_ENV:CLIENT_SECRET_ENV, basic:USER_ENV:PASS_ENV. Returns [] for an
// empty spec and { invalid: scheme } for an unrecognised one, so a broken spec
// is reported as a broken spec rather than a silently-passing check.
export function authEnvVars(spec) {
  if (!spec) return [];
  const auth = parseAuthReference(spec);
  if (!auth) return { invalid: spec };
  if (auth.scheme === 'oauth') return [auth.clientIdEnv, auth.clientSecretEnv];
  if (auth.scheme === 'basic') return [auth.usernameEnv, auth.passwordEnv];
  return [auth.envVar];
}

// Static readiness is not an authentication check. Accept the provider-local
// snapshot explicitly so doctor and tool discovery cannot borrow another
// provider's env-file values. No credential values leave this helper.
export function authReadiness(spec, environment) {
  if (!spec) return { state: 'none', vars: [] };
  const auth = parseAuthReference(spec);
  if (!auth) return { state: 'invalid', vars: [] };
  const vars = authEnvVars(spec);
  const missing = vars.filter(name => !environment[name]);
  if (missing.length) return { state: 'missing', vars, missing };
  const problem = auth.scheme === 'basic'
    ? basicAuthValueProblem(environment[auth.usernameEnv], environment[auth.passwordEnv]) : null;
  return problem ? { state: 'invalid_value', vars, problem } : { state: 'present', vars };
}

export function resolveConfig(cwd = process.cwd(), { environment, stack, upstream, path } = {}) {
  const active = currentStackScope();
  const builtinRequested = isBuiltinStack(stack ?? upstream) || isBuiltinFeedbackTarget(path);
  if (scopeMatches(active, cwd, arguments.length === 0) && (!builtinRequested || active.builtin)) return active.config;
  const root = stackProjectRoot(stackStart(cwd, arguments.length === 0)), catalog = stackCatalog(root);
  if (catalog.stacks.length || catalog.problems.length || isBuiltinStack(stack ?? upstream) || isBuiltinFeedbackTarget(path)) {
    try { return resolveStack(root, { stack, upstream, path: path ?? "", environment }).config; }
    catch (error) {
      const defaults = resolveDefaults(catalog.defaults);
      return { root, name: null, file: null, problems: [{ code: error.code ?? "STACK_INVALID", message: error.message, details: error.details ?? {}, ...(error.next ? { next:error.next } : {}) }], variables: {}, hosts: {}, credentialEnvFiles: [], defaults, concurrency: defaults.concurrency };
    }
  }
  // A previous resolution's files are not inherited environment for this one.
  releaseFileEnvironment();
  const found = findConfigFile(cwd);
  const problems = [];
  const explicitlyRequested = environment !== undefined;

  if (found && found.missing) {
    problems.push({ code: "CONFIG_NOT_FOUND",
      message: `API_CONFIG points at ${found.missing}, which does not exist.`,
      next: `Correct API_CONFIG, or unset it to search for ${LAYOUT.environments}.` });
    return { env: null, name: null, file: null, problems, variables: {}, hosts: {},
      defaults: resolveDefaults(), concurrency: resolveDefaults().concurrency };
  }

  let config = null;
  if (found) {
    try { config = JSON.parse(readFileSync(found, "utf8")); }
    catch (e) {
      problems.push({ code: "CONFIG_INVALID",
        message: `${found} is not valid JSON: ${String(e.message).slice(0, 120)}`,
        next: "Fix the syntax, or remove the file to fall back to environment variables." });
      return { env: null, name: null, file: found, problems, variables: {}, hosts: {},
        defaults: resolveDefaults(), concurrency: resolveDefaults().concurrency };
    }
  }

  // Config is committed project input. Header and variable values are
  // credential-bearing surfaces and must be references, never literals.
  const configSecret = (value) => {
    if (typeof value === "string") return secretIn(value);
    if (Array.isArray(value)) return value.find(configSecret);
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const hit = configSecret(item);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const [envName, envValue] of Object.entries(config?.environments ?? {})) {
    for (const surface of ["headers", "variables"]) {
      const hit = configSecret(envValue?.[surface]);
      if (hit) problems.push({ code: "CONFIG_SECRET_LITERAL",
        message: `Environment '${envName}' contains ${hit} in ${surface}; literal values are refused.`,
        next: `Replace the value with an environment-variable reference.` });
    }
  }

  if (explicitlyRequested && !found) {
    problems.push({ code: "ENVIRONMENT_CONFIG_REQUIRED",
      message: `Environment '${environment}' was requested explicitly, but no ${LAYOUT.environments} was found.`,
      next: `Add ${LAYOUT.environments} with that named environment, or remove --env.` });
  }

  const environments = config?.environments ?? {};
  // A CLI --env request is explicit user intent and outranks ambient API_ENV
  // and the checked-in default. Callers that do not supply it retain the
  // established environment-variable/config precedence unchanged.
  const requested = environment ?? process.env.API_ENV ?? config?.default ?? null;
  let env = null, name = null;

  if (requested) {
    // Object.hasOwn, not a bare index: `API_ENV=__proto__` reaches
    // Object.prototype, which is truthy, so the lookup "succeeded" with a junk
    // environment instead of reporting ENVIRONMENT_NOT_FOUND.
    if (Object.hasOwn(environments, requested)) { env = environments[requested]; name = requested; }
    else if (config) {
      problems.push({ code: "ENVIRONMENT_NOT_FOUND",
        message: `No environment named '${requested}' in ${found}.`,
        details: { available: Object.keys(environments) },
        next: `Use one of: ${Object.keys(environments).join(", ") || "(none defined)"}.` });
    }
  }

  // Per-host upstreams: top-level entries shared by every environment, then the
  // selected environment's own, which are more specific and therefore win.
  // Spread copies own properties only, so a "__proto__" key in the JSON cannot
  // reach Object.prototype (same reasoning as the environment lookup above).
  const hosts = {};
  for (const [name, h] of Object.entries({ ...config?.hosts, ...env?.hosts })) {
    if (!h || typeof h !== "object") continue;
    // Trailing slash normalised HERE, once, so both adapters agree on origins.
    hosts[name] = { ...h, baseUrl: typeof h.baseUrl === "string" ? h.baseUrl.replace(/\/$/, "") : h.baseUrl,
      // Each upstream binds its own contract. API_CONTRACT overrides only the
      // primary API; it must never move that API's routes to another provider.
      ...(typeof h.contract === "string" && h.contract
        ? { contract: resolve(projectConfigRoot(found), expand(h.contract)) } : {}) };
  }

  // Preserve the established cwd-relative env-file paths and bind them now;
  // subsequent credential reads must not depend on a changing process cwd.
  const primaryEnvFile = env?.envFile ? resolve(expand(env.envFile)) : undefined;
  const fallbackEnvFile = process.env.API_ENV_FILE ? resolve(expand(process.env.API_ENV_FILE)) : undefined;
  const credentialEnvFiles = [primaryEnvFile, fallbackEnvFile].filter(Boolean);
  for (const h of Object.values(hosts)) {
    h.credentialEnvFiles = [h.envFile ? resolve(expand(h.envFile)) : primaryEnvFile, fallbackEnvFile].filter(Boolean);
  }

  // Credentials for the selected environment, before auth is resolved. Host
  // entries may name their own env file — vendor keys commonly live apart.
  if (env?.envFile) loadEnvFile(env.envFile);
  for (const h of Object.values(hosts)) if (h.envFile) loadEnvFile(h.envFile);
  if (process.env.API_ENV_FILE) loadEnvFile(process.env.API_ENV_FILE);

  // Client defaults, env > file's `defaults` block > built-in (resolveDefaults).
  const defaults = resolveDefaults({ ...readStandaloneDefaults(cwd), ...config?.defaults });
  // A per-ENVIRONMENT concurrency is MORE specific than the top-level defaults
  // block, so it wins over it — but still yields to an explicit API_CONCURRENCY,
  // which resolveDefaults already applied. Fold it in here, where the selected
  // environment is finally known. Guarded so a junk env-level value cannot
  // undo the finite default.
  if (process.env.API_CONCURRENCY === undefined && env?.concurrency !== undefined) {
    const n = Number(env.concurrency);
    if (Number.isFinite(n) && n >= 1) defaults.concurrency = n;
  }

  // Explicit environment variables always beat the config file, so existing
  // single-environment usage keeps working untouched.
  const settled = {
    name,
    file: found ?? null,
    baseUrl: (process.env.API_BASE_URL ?? env?.baseUrl ?? FALLBACK_BASE_URL).replace(/\/$/, ""),
    // WHERE the base URL came from, which is a different question from what it
    // is. Nothing else in the resolved config can answer it afterwards: the
    // fallback is a normal-looking localhost URL, so a reader comparing values
    // cannot tell "the user chose 127.0.0.1:8000" from "nobody chose anything".
    // `doctor` needs that distinction — a green "reachable" against a URL the
    // user never set is a check passing on a coincidence.
    baseUrlSource: process.env.API_BASE_URL !== undefined ? "env"
      : env?.baseUrl !== undefined ? "config" : "fallback",
    baseUrlOverride: process.env.API_BASE_URL !== undefined,
    contract: process.env.API_CONTRACT ?? (env?.contract ? resolve(projectConfigRoot(found), expand(env.contract)) : undefined),
    contractPathPrefix: env?.contractPathPrefix,
    auth: process.env.API_AUTH ?? env?.auth,
    credentialEnvFiles,
    hosts,
    headers: env?.headers ?? {},
    variables: env?.variables ?? {},
    // The full defaults bundle (budget, timeoutMs, concurrency, evidenceDir,
    // staleDays) for the client to read at load, and `concurrency` kept as a
    // top-level field for the existing readers that already reach for it.
    defaults,
    concurrency: defaults.concurrency,
    production: Boolean(env?.production),
    problems,
  };
  return settled;
}

// An agent cannot tell staging from production by looking at a URL, and it has
// none of the institutional context a long-tenured engineer uses to know the
// difference. The config declares it; the client refuses on its behalf.
export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function productionGuard(config, method) {
  if (!config.production || !WRITE_METHODS.has(method)) return null;
  if (process.env.API_ALLOW_PRODUCTION_WRITES === "1") return null;
  return {
    kind: "policy", code: "PRODUCTION_WRITE_REFUSED",
    message: `Environment '${config.name}' is marked production and ${method} is a write.`,
    details: { environment: config.name, method, baseUrl: config.baseUrl },
    next: "Re-run against a non-production environment. If the production write is intended, set API_ALLOW_PRODUCTION_WRITES=1 in the MCP server's launch environment (edit the host's server configuration, then restart the server in the host), or in your shell for CLI runs.",
  };
}
