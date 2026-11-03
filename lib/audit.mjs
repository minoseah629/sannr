import { LAYOUT } from './layout.mjs';
// Repo-wide audit: the first thing a new adopter runs.
//
// An inventory is a list, and nobody shares a list. The output that matters is
// the DISCREPANCY — every place a checked-in contract and a running server
// disagree — because that is the org measuring its own rate of being
// confidently wrong, on day one, before anything has accumulated.
//
// Ownership is harvested, never asked for: CODEOWNERS already exists and is
// maintained for review routing, and git history knows who is currently active.
// Neither requires a human to write anything.

import { readdirSync, readFileSync, existsSync, statSync, lstatSync } from "node:fs";
import { join, relative, dirname, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readContract, operationsFrom, loadContext, saveContext, confidenceFor,
  liveContractDigest, shapeHash, rowsOf, responseSchema } from "./context.mjs";
import { responseFindings, bareRejectionFinding, staticStatusFindings,
  sampledId, listedIdSource, rowsAnywhere, pageFull, baselineFindings, dedupeSchemaMismatch, declaredStatuses } from "./checks.mjs";
import { declaredPropertyNames } from "./key-sources.mjs";
import { observeResponse, serviceConsistency, serviceSummary } from "./consistency.mjs";
import { resolveConfig } from "./config.mjs";
import { currentSourceScan } from './source-scan.mjs';

const SKIP = new Set(["node_modules", ".git", "venv", ".venv", "dist", "build", ".next",
  "__pycache__", "coverage", "vendor", "target", "evidence", ".turbo", "site-packages"]);

// A fixture is not a service. Reporting test data as production API surface is
// how an audit becomes noise nobody reads — but it is EXCLUDED AND COUNTED,
// never silently dropped.
const FIXTURE_PATH = /\/(fixtures?|__fixtures__|testdata|test-data|samples?|examples?|e2e|__tests__|spec\/support)\//i;
const SPEC_RE = /^(openapi|swagger)[^/]*\.(ya?ml|json)$/i;

const sourceFiles = dir => currentSourceScan(dir)?.sourceFiles(dir) ?? walk(dir);
const sourceMemo = (dir, key, build) => {
  const scan = currentSourceScan(dir);
  return scan?.memo ? scan.memo(JSON.stringify(['audit', resolve(dir), key]), build) : build();
};
function sourceText(file) {
  const scan = currentSourceScan(dirname(file));
  if (scan) return scan.read(file);
  try { const stat = lstatSync(file); return stat.isFile() && stat.size <= 400_000 ? readFileSync(file, 'utf8') : null; } catch { return null; }
}
function lineReader(source, file) {
  const scan = file && currentSourceScan(dirname(file));
  if (scan) return offset => scan.line(file, offset);
  const starts = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) starts.push(at + 1);
  return offset => {
    let low = 0, high = starts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) low = mid + 1; else high = mid; }
    return low;
  };
}

// A service without a spec still has an API; framework signals find it so the
// audit reports "undocumented" rather than pretending it does not exist.
const FRAMEWORK_SIGNALS = [
  [/@(?:app|router)\.(get|post|put|patch|delete)\s*\(/g, "fastapi/flask"],
  [/\b(?:app|router|api)\.(get|post|put|patch|delete)\s*\(\s*['"`]\//g, "express/hono/fastify"],
  [/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g, "next-route-handler"],
  [/@(?:Get|Post|Put|Patch|Delete)\s*\(/g, "nest/spring"],
];

// Route definitions with the PATH captured, so a route in the code can be
// compared to the contract. This finds the case a count-only scan cannot: a
// live route inside a service whose spec looks complete — a debug endpoint, an
// admin backdoor, a forgotten /internal route.
const EXPRESS_RECEIVER = "(?:app|router|api|route[rs]?|server|[A-Za-z_$][\\w$]*)";
const ROUTE_PATTERNS = [
  // express / hono / fastify:  app.get("/path", …)   router.post('/path', …)
  new RegExp("\\b" + EXPRESS_RECEIVER +
    "\\s*\\.\\s*(get|post|put|patch|delete)\\s*\\(\\s*['\"`](\\/[^'\"`]*)['\"`]", "gi"),
  // fastapi / flask decorator:  @app.get("/path")    @router.post("/path")
  /@\s*(?:app|router|blueprint|bp)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)['"`]/gi,
  // fastify object form:  { method: "GET", url: "/path" }
  /method\s*:\s*['"`](get|post|put|patch|delete)['"`]\s*,\s*url\s*:\s*['"`](\/[^'"`]*)['"`]/gi,
];

// Conventional operational endpoints. Undocumented by custom, not by mistake;
// reporting them as findings would bury the routes that actually matter. Still
// counted, never silently dropped.
const INFRA_ROUTE = /^\/(health|healthz|livez|readyz|ready|live|ping|status|metrics|favicon\.ico|openapi\.(json|ya?ml)|docs|swagger)\/?$/i;

// Collapse both `:id` (express/hono) and `{id}` (openapi) params to one form so
// a code route and a declared route compare as equal.
export const canonPath = (p) => p.replace(/:[A-Za-z0-9_]+/g, "{}").replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "") || "/";

// A route defined in a test file, or a path with an unresolved template
// interpolation, is not a real declared route. Reporting either as a shadow
// route is crying wolf — confirmed against real repos, where a test's
// `/widgets/${id}` and a sub-router's bare `/{id}` both looked like undocumented
// endpoints. This distinction did not exist in the corpus (inline full paths,
// no test files), which is exactly why the corpus alone could not be trusted.
// Windows hands us `src\\tests\\app.mjs`. Every guard below is written with
// forward slashes, so without normalising, TEST_FILE and FIXTURE_PATH silently
// stop matching on Windows and the tool reports test files and fixtures as real
// API routes — the cry-wolf failure, on an entire platform. Normalising both
// separators is deliberate: on POSIX a literal backslash in a filename is
// vanishingly rare, and the failure direction is safe (over-exclusion beats a
// false positive).
export const toPosix = (p) => String(p).replace(/\\/g, "/");

const TEST_FILE = /(\.|\/|^)(test|spec)\.|\/(tests?|__tests__|spec|e2e)\//i;
const hasInterpolation = (p) => /\$\{|\{\{|`/.test(p);

// A router mounted under a prefix defines routes relative to it: FastAPI's
// APIRouter(prefix="/x"), Hono's .basePath("/x"). Without resolving the prefix,
// every sub-router route reads as undocumented.
function filePrefix(src) {
  const fastapi = src.match(/APIRouter\s*\(\s*[^)]*?prefix\s*=\s*['"](\/[^'"]*)['"]/);
  if (fastapi) return fastapi[1].replace(/\/+$/, "");
  const hono = src.match(/\.basePath\s*\(\s*['"`](\/[^'"`]*)['"`]/);
  if (hono) return hono[1].replace(/\/+$/, "");
  return "";
}

// Express mount paths are relationships, not file-wide prefixes. A service can
// mount three routers from one source file under three unrelated paths; applying
// every discovered prefix to every route is a cross product of endpoints that do
// not exist. Record the receiver on each side of `use(prefix, router)` and follow
// only that edge. Factory calls are resolved through the receiver they return:
//
//   app.use("/api", createApiRouter())
//   createApiRouter: router.use("/v1", createChildRouter())
//
// becomes app -> router (/api) -> child router (/v1), so the child's local
// `/:id` is `/api/v1/:id`. The deliberately small parser below only reads named
// function boundaries and literal mount paths. An unresolved/dynamic mount stays
// local rather than borrowing somebody else's prefix and inventing a route.
const EXPRESS_MOUNT = new RegExp("\\b(" + EXPRESS_RECEIVER +
  ")\\s*\\.\\s*use\\s*\\(\\s*['\"`](\\/[^'\"`]*)['\"`]\\s*,\\s*((?:[A-Za-z_$][\\w$]*)(?:\\.[A-Za-z_$][\\w$]*\\(\\))?)", "gi");
const NAMED_FUNCTION = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^={]+)?\s*\{/g;
const ARROW_FUNCTION = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>\s*\{/g;
// Class methods are factories too: `app.use("/x", store.router())` is the
// same relationship as a named function factory, just with a call boundary.
const METHOD_FUNCTION = /(?:^|[\n{};])\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^={]+)?\s*\{/g;
const NAMED_IMPORT = /\bimport\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
const EXPORTED_DECLARATION = /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const EXPORTED_LIST = /\bexport\s*\{([^}]+)\}(?!\s*from)/g;
const LOCAL_DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g;
const ROUTER_INITIALIZER = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:express\s*\.\s*)?Router\s*\(/g;
const FIXED_EXPRESS_RECEIVERS = new Set(["app", "router", "api", "route", "routes", "server"]);

function closingBrace(src, open) {
  let depth = 0, quote = null, lineComment = false, blockComment = false;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i], next = src[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (c === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i;
  }
  return src.length;
}

function functionScopes(src, file) {
  const scopes = [];
  const seenOpens = new Set();
  const parameterNames = (text) => text.split(",").map((p) => p.trim().replace(/^\.\.\./, "")
    .replace(/^(?:public|private|protected|readonly)\s+/, "")
    .split(/[?:=]/, 1)[0].trim()).filter(Boolean);
  for (const re of [NAMED_FUNCTION, ARROW_FUNCTION]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const open = m.index + m[0].lastIndexOf("{");
      const end = closingBrace(src, open);
      const body = src.slice(open + 1, end);
      const returned = [...body.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\s*;?/g)].at(-1)?.[1] ?? null;
      const rawParams = (m[2] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      scopes.push({ id: `${file}#${m[1]}@${open}`, name: m[1], file, open, end, returned,
        params: parameterNames(m[2] ?? ""), rawParams });
      seenOpens.add(open);
    }
  }
  // Do not attempt to parse class structure; a method name is only accepted
  // when its body is unique, which keeps dynamic property names unresolved.
  METHOD_FUNCTION.lastIndex = 0;
  for (const m of src.matchAll(METHOD_FUNCTION)) {
    if (["if", "for", "while", "switch", "catch", "with"].includes(m[1])) continue;
    const before = src.slice(Math.max(0, m.index), m.index + m[0].indexOf(m[1]));
    if (/\b(?:function|if|for|while|switch|catch)\s*$/.test(before)) continue;
    const open = m.index + m[0].lastIndexOf("{");
    const end = closingBrace(src, open);
    if (seenOpens.has(open)) continue;
    const body = src.slice(open + 1, end);
    const returned = [...body.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\s*;?/g)].at(-1)?.[1] ?? null;
    scopes.push({ id: `${file}#${m[1]}@${open}`, name: m[1], file, open, end, returned,
      params: parameterNames(m[2]), rawParams: m[2].split(",").map((p) => p.trim()).filter(Boolean),
      method: true, typedReturn: /\)\s*:/.test(m[0]) });
    seenOpens.add(open);
  }
  return scopes;
}

const rootScope = (file) =>
  ({ id: `${file}#<root>`, name: null, file, open: -1, end: Infinity, returned: null });

function scopeIndex(scopes) {
  const files = new Map(), parents = new Map();
  for (const scope of scopes) (files.get(scope.file) ?? files.set(scope.file, []).get(scope.file)).push(scope);
  for (const list of files.values()) {
    list.sort((a, b) => a.open - b.open || b.end - a.end);
    const enclosing = [];
    for (const scope of list) {
      while (enclosing.length && enclosing.at(-1).end <= scope.open) enclosing.pop();
      parents.set(scope, enclosing.at(-1) ?? null);
      enclosing.push(scope);
    }
  }
  return { files, parents };
}

function containingScope(indexed, file, index, stats) {
  if (stats) stats.route_scope_lookups++;
  const scopes = indexed.files.get(file) ?? [];
  let low = 0, high = scopes.length;
  while (low < high) {
    if (stats) stats.route_scope_comparisons++;
    const mid = (low + high) >>> 1;
    if (scopes[mid].open < index) low = mid + 1; else high = mid;
  }
  // The closest preceding scope may already have closed. Its parent can
  // still contain this declaration; a neighbouring function cannot.
  let scope = scopes[low - 1];
  while (scope) {
    if (stats) stats.route_scope_comparisons++;
    if (index < scope.end) return scope;
    scope = indexed.parents.get(scope);
  }
  return rootScope(file);
}

function lexicalScopeChain(indexed, scope) {
  if (!scope.name) return [scope];
  const chain = [];
  for (let parent = scope; parent; parent = indexed.parents.get(parent)) chain.push(parent);
  chain.push(rootScope(scope.file));
  return chain;
}

const routeReceiver = (match) =>
  /(?:@\s*)?\b([A-Za-z_$][\w$]*)\s*\./.exec(match[0])?.[1] ?? "<object-route>";
const routeNode = (scope, receiver) => `${scope.id}::${receiver}`;
const joinRoute = (prefix, path) =>
  (`${prefix.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`
    .replace(/\/{2,}/g, "/").replace(/\/+$/, "")) || "/";

function importedFile(importer, specifier, sourcesByPosix) {
  if (!specifier.startsWith(".")) return null;
  const path = toPosix(join(dirname(importer), specifier));
  const exact = sourcesByPosix.get(path);
  if (exact) return exact;
  const stem = path.replace(/\.[^/.]+$/, "");
  const extensions = /\.[^/.]+$/.test(path)
    ? [".js", ".mjs", ".ts", ".tsx", ".jsx"]
    : [".js", ".mjs", ".ts", ".tsx", ".jsx", "/index.js", "/index.mjs", "/index.ts"];
  const matches = [...new Set(extensions.map((ext) => sourcesByPosix.get(`${stem}${ext}`)).filter(Boolean))];
  return matches.length === 1 ? matches[0] : null;
}

function moduleSymbols(sources, sourcesByPosix = new Map(sources.map((s) => [toPosix(s.file), s.file]))) {
  const exports = new Map();       // file -> exported name -> local name
  const imports = new Map();       // "file::local name" -> {file, exported}
  const exportName = (file, exported, local) => {
    const names = exports.get(file) ?? new Map();
    // Invalid/ambiguous duplicate exports do not get guessed through.
    names.set(exported, names.has(exported) && names.get(exported) !== local ? null : local);
    exports.set(file, names);
  };

  for (const { file, src } of sources) {
    EXPORTED_DECLARATION.lastIndex = 0;
    for (const m of src.matchAll(EXPORTED_DECLARATION)) exportName(file, m[1], m[1]);
    EXPORTED_LIST.lastIndex = 0;
    for (const m of src.matchAll(EXPORTED_LIST)) {
      for (const item of m[1].split(",")) {
        const parts = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        if (parts[0]) exportName(file, parts[1] ?? parts[0], parts[0]);
      }
    }
    NAMED_IMPORT.lastIndex = 0;
    for (const m of src.matchAll(NAMED_IMPORT)) {
      const targetFile = importedFile(file, m[2], sourcesByPosix);
      if (!targetFile) continue;
      for (const item of m[1].split(",")) {
        const parts = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        if (!parts[0]) continue;
        const local = parts[1] ?? parts[0];
        const key = `${file}::${local}`;
        const value = { file: targetFile, exported: parts[0] };
        const prior = imports.get(key);
        imports.set(key, prior && (prior.file !== value.file || prior.exported !== value.exported) ? null : value);
      }
    }
  }
  return { exports, imports };
}

function routeSources(sources) {
  const byPath = new Map(sources.map(source => [toPosix(source.file), source.file]));
  const selected = new Set(), dependencies = new Map(), callers = new Map(), mountNames = new Set();
  const matches = (re, source) => { re.lastIndex = 0; return re.test(source); };
  for (const { file, src } of sources) {
    if ([...ROUTE_PATTERNS, ROUTER_INITIALIZER, EXPRESS_MOUNT].some(re => matches(re, src))) selected.add(file);
    EXPRESS_MOUNT.lastIndex = 0;
    for (const match of src.matchAll(EXPRESS_MOUNT)) {
      const method = /^(\w+)\.(\w+)\(\)$/.exec(match[3]);
      mountNames.add(method?.[2] ?? match[3]);
    }
    NAMED_IMPORT.lastIndex = 0;
    for (const match of src.matchAll(NAMED_IMPORT)) {
      const target = importedFile(file, match[2], byPath);
      if (!target) continue;
      (dependencies.get(file) ?? dependencies.set(file, new Set()).get(file)).add(target);
      // A registrar caller may have no route literal of its own. Retain it
      // when it actually uses an imported route factory/router in a call.
      for (const item of match[1].split(',')) {
        const parts = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        const local = parts[1] ?? parts[0];
        if (!local || !new RegExp(`\\b${escRe(local)}\\s*\\(|[,(]\\s*${escRe(local)}\\s*[,)]`).test(src.slice(match.index + match[0].length))) continue;
        (callers.get(target) ?? callers.set(target, new Set()).get(target)).add(file);
      }
    }
  }
  // Existing mount resolution has a global unique-name fallback. Include all
  // owners of those names so filtering cannot turn ambiguity into a guess.
  if (mountNames.size) for (const { file, src } of sources) {
    for (const re of [NAMED_FUNCTION, ARROW_FUNCTION, METHOD_FUNCTION]) {
      re.lastIndex = 0;
      let ownsTarget = false;
      for (const match of src.matchAll(re)) if (mountNames.has(match[1])) { ownsTarget = true; break; }
      if (ownsTarget) { selected.add(file); break; }
    }
  }
  const calling = [...selected];
  for (let at = 0; at < calling.length; at++) for (const caller of callers.get(calling[at]) ?? [])
    if (!selected.has(caller)) { selected.add(caller); calling.push(caller); }
  // Forward imports preserve aliases and router/registrar dependencies. They
  // do not bring every unrelated importer of a shared utility into the pass.
  const pending = [...selected];
  for (let at = 0; at < pending.length; at++) for (const target of dependencies.get(pending[at]) ?? [])
    if (!selected.has(target)) { selected.add(target); pending.push(target); }
  return sources.filter(source => selected.has(source.file));
}

/** Extract (method, path, file) route definitions from a service's source. */
export function extractRoutes(dir) {
  return sourceMemo(dir, ['routes'], () => extractRoutesUncached(dir));
}
function extractRoutesUncached(dir) {
  let sources = [];
  for (const f of sourceFiles(dir)) {
    if (!/\.(py|ts|js|mjs|tsx|jsx|rb|go)$/.test(f)) continue;
    if (TEST_FILE.test(toPosix(f)) && !/\/test\/fixtures\//i.test(toPosix(f))) continue;
    const src = sourceText(f); if (src === null) continue;
    sources.push({ file: relative(dir, f), src, prefix: filePrefix(src), lineAt: lineReader(src, f) });
  }

  const stats = currentSourceScan(dir)?.stats;
  if (stats) for (const name of ['route_source_files', 'route_candidate_files', 'route_scopes_indexed', 'route_scope_lookups', 'route_scope_comparisons']) stats[name] ??= 0;
  if (stats) stats.route_source_files += sources.length;
  // Import resolution uses the full path inventory even though only relevant
  // modules need scope analysis. A filtered non-route file can still be a
  // competing target of an extensionless import.
  const sourcePaths = new Map(sources.map(source => [toPosix(source.file), source.file]));
  sources = routeSources(sources);
  if (stats) stats.route_candidate_files += sources.length;
  const scopes = sources.flatMap(({ src, file }) => functionScopes(src, file));
  if (stats) stats.route_scopes_indexed += scopes.length;
  const indexed = scopeIndex(scopes);
  const sourcesByFile = new Map(sources.map(source => [source.file, source]));
  const functionsByName = new Map();
  const functionsByFileAndName = new Map();
  for (const scope of scopes) {
    (functionsByName.get(scope.name) ?? functionsByName.set(scope.name, []).get(scope.name)).push(scope);
    const key = `${scope.file}::${scope.name}`;
    (functionsByFileAndName.get(key) ?? functionsByFileAndName.set(key, []).get(key)).push(scope);
  }
  const symbols = moduleSymbols(sources, sourcePaths);
  const localBindings = new Set();
  const routerInitializers = new Map();
  for (const { file, src } of sources) {
    LOCAL_DECLARATION.lastIndex = 0;
    for (const m of src.matchAll(LOCAL_DECLARATION)) {
      const scope = containingScope(indexed, file, m.index, stats);
      localBindings.add(routeNode(scope, m[1]));
    }
    ROUTER_INITIALIZER.lastIndex = 0;
    for (const m of src.matchAll(ROUTER_INITIALIZER)) {
      const scope = containingScope(indexed, file, m.index, stats);
      const node = routeNode(scope, m[1]);
      routerInitializers.set(node, { scope, node });
    }
  }

  const definitions = [];
  const mounts = [];
  const registrarCalls = [];
  const nodesByScope = new Map();
  const noteNode = (scope, node) =>
    (nodesByScope.get(scope.id) ?? nodesByScope.set(scope.id, new Set()).get(scope.id)).add(node);
  for (const initialized of routerInitializers.values()) noteNode(initialized.scope, initialized.node);

  const provenRouterNode = (file, scope, receiver) => {
    for (const lexical of lexicalScopeChain(indexed, scope)) {
      const local = routeNode(lexical, receiver);
      if (!localBindings.has(local)) continue;
      // The nearest declaration owns the name. A client binding here shadows
      // every outer/imported router of the same spelling.
      return routerInitializers.has(local) ? local : null;
    }
    const imported = symbols.imports.get(`${file}::${receiver}`);
    if (!imported) return null;
    const localName = symbols.exports.get(imported.file)?.get(imported.exported);
    if (!localName) return null;
    const target = routeNode(rootScope(imported.file), localName);
    return routerInitializers.has(target) ? target : null;
  };

  for (const { file, src, prefix, lineAt } of sources) {
    for (const re of ROUTE_PATTERNS) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        if (hasInterpolation(m[2])) continue;
        const scope = containingScope(indexed, file, m.index, stats);
        const receiver = routeReceiver(m);
        let node = routeNode(scope, receiver);
        if (!FIXED_EXPRESS_RECEIVERS.has(receiver.toLowerCase())) {
          node = provenRouterNode(file, scope, receiver);
          // A locally declared non-router (the common axios `clientRouter`)
          // is known not to be a route receiver. Unknown identities remain in
          // the audit with an explicit reason instead of disappearing.
          if (!node) {
            const line = src.slice(src.lastIndexOf("\n", m.index) + 1, m.index);
            const hasLocalBinding = [...localBindings].some((binding) => binding.endsWith(`::${receiver}`));
            const unknownRequire = new RegExp(`\\b${receiver}\\s*=\\s*require\\s*\\(`).test(src);
            if (!/Router$/i.test(receiver) || (hasLocalBinding && !unknownRequire) || /axios\s*\.\s*create|fetch\s*\(/i.test(line)) continue;
            node = routeNode(scope, receiver);
          }
        }
        noteNode(scope, node);
        definitions.push({ node, method: m[1].toUpperCase(), path: joinRoute(prefix, m[2]), file, line: lineAt(m.index),
          unresolved: !FIXED_EXPRESS_RECEIVERS.has(receiver.toLowerCase()) && !provenRouterNode(file, scope, receiver)
            ? "unresolved router identity" : null });
      }
    }
    EXPRESS_MOUNT.lastIndex = 0;
    for (const m of src.matchAll(EXPRESS_MOUNT)) {
      const scope = containingScope(indexed, file, m.index, stats);
      const source = routeNode(scope, m[1]);
      noteNode(scope, source);
      mounts.push({ scope, source, prefix: m[2], targetName: m[3] });
    }
    // `registerRoutes(router, deps)` links the caller's router identity to the
    // registrar's parameter identity. Imported registrars are resolved below.
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/g)) {
      if (/^[^)]*\)\s*\{/.test(src.slice(m.index + m[0].length))) continue;
      const scope = containingScope(indexed, file, m.index, stats);
      if (scope.name === m[1] || m[1] === "Router") continue;
      registrarCalls.push({ file, scope, name: m[1], arg: m[2], index: m.index });
    }
  }

  const factoryNode = (factory) => factory.returned ? routeNode(factory, factory.returned) :
    [...(nodesByScope.get(factory.id) ?? [])][0];
  const targetInFile = (file, name) => {
    const factories = functionsByFileAndName.get(`${file}::${name}`) ?? [];
    if (factories.length === 1) return factoryNode(factories[0]);
    if (factories.length > 1) return null;
    const scope = rootScope(file);
    const instance = routeNode(scope, name);
    return (nodesByScope.get(scope.id) ?? new Set()).has(instance) ? instance : null;
  };

  const methodTarget = (file, name) => {
    const local = functionsByFileAndName.get(`${file}::${name}`) ?? [];
    const candidates = (local.length ? local : (functionsByName.get(name) ?? []))
      .filter((f) => f.method && [...(nodesByScope.get(f.id) ?? [])].length);
    return candidates.length === 1 ? factoryNode(candidates[0]) : null;
  };

  // Resolve explicit relative imports first, then same-file symbols, and only
  // then a globally unique factory name. Every step must identify one target;
  // ambiguity is left unresolved rather than spreading one prefix across every
  // same-named router in the service tree.
  const edges = [];
  const registrarParameterNodes = new Set();
  for (const mount of mounts) {
    let target;
    const methodCall = /^(\w+)\.(\w+)\(\)$/.exec(mount.targetName);
    const imported = symbols.imports.get(`${mount.scope.file}::${mount.targetName}`);
    if (imported) {
      const localName = symbols.exports.get(imported.file)?.get(imported.exported);
      if (localName) target = targetInFile(imported.file, localName);
    }
    if (!target) target = targetInFile(mount.scope.file, mount.targetName);
    if (!target && methodCall) target = methodTarget(mount.scope.file, methodCall[2]);
    if (!target) {
      const local = routeNode(mount.scope, mount.targetName);
      if ((nodesByScope.get(mount.scope.id) ?? new Set()).has(local)) target = local;
    }
    const candidates = functionsByName.get(mount.targetName) ?? [];
    if (!target && candidates.length === 1) target = factoryNode(candidates[0]);
    if (target) {
      const methodCall = /^(\w+)\.(\w+)\(\)$/.exec(mount.targetName);
      let rule = "mount";
      if (methodCall) {
        const nearby = sourcesByFile.get(mount.scope.file)?.src.slice(
          Math.max(mount.scope.open + 1, sourcesByFile.get(mount.scope.file)?.src.lastIndexOf("\n", mount.scope.open) ?? 0),
          mount.scope.end,
        ) ?? "";
        const methodScope = [...scopes].find((s) => factoryNode(s) === target && s.method);
        const guarded = new RegExp(`is[A-Za-z_$][\\w$]*\\s*\\(\\s*${methodCall[1]}\\s*\\)`).test(nearby);
        const defaulted = new RegExp(`\\b${methodCall[1]}\\s*=\\s*[^;\\n]+\\?\\?\\s*[A-Za-z_$][\\w$]*`).test(nearby);
        rule = methodScope?.typedReturn && guarded && defaulted
          ? "mount(type-guarded) + instance(factory default) + method router"
          : methodScope?.typedReturn ? "mount(method) + method router" : "mount";
      } else {
        const source = sourcesByFile.get(mount.scope.file)?.src ?? "";
        const mountText = source.slice(Math.max(0, mount.scope.open + 1), mount.scope.end);
        const multiline = /use\s*\(\s*\n|use\s*\([^\n]*,\s*\n/.test(mountText);
        const factory = [...scopes].find((s) => factoryNode(s) === target);
        const optional = factory?.rawParams?.filter((p) => /\?\s*:|=/.test(p)).length ?? 0;
        const objectParam = factory?.rawParams?.some((p) => /^\w+\s*:\s*\{/.test(p)) ?? false;
        const factoryRule = objectParam ? "factory(options object)" : optional ? "factory(positional, optional param)" : null;
        rule = [multiline ? "mount(multi-line)" : "mount", factoryRule].filter(Boolean).join(" + ");
      }
      edges.push({ from: mount.source, to: target, prefix: mount.prefix, rule });
    }
  }

  for (const call of registrarCalls) {
    const imported = symbols.imports.get(`${call.file}::${call.name}`);
    let targetFile = call.file, exported = call.name;
    if (imported) { targetFile = imported.file; exported = imported.exported; }
    const candidates = functionsByFileAndName.get(`${targetFile}::${exported}`) ?? [];
    if (candidates.length !== 1) continue;
    const registrar = candidates[0];
    const param = registrar.params?.[0];
    if (!param) continue;
    // A registrar call's first argument may be a typed alias (`router: Router`
    // in the callee), but the caller's identity is still the factory router.
    // Prefer that proven factory node so multiline typed factories compose
    // through the same edge as their local routes.
    const from = call.scope.name && factoryNode(call.scope) === routeNode(call.scope, call.arg)
      ? factoryNode(call.scope) : routeNode(call.scope, call.arg);
    const to = routeNode(registrar, param);
    registrarParameterNodes.add(to);
    noteNode(call.scope, from); noteNode(registrar, to);
    const source = sourcesByFile.get(call.file)?.src ?? "";
    const beforeCall = source.slice(call.scope.open + 1, call.index);
    const guarded = /if\s*\([^)]*\)\s*\{\s*$/.test(beforeCall);
    edges.push({ from, to, prefix: "", rule: `${guarded ? "if(param) + " : ""}registrar(param)` });
  }

  const nodes = new Set(definitions.map((d) => d.node));
  for (const e of edges) { nodes.add(e.from); nodes.add(e.to); }
  const incoming = new Set(edges.map((e) => e.to));
  const prefixes = new Map([...nodes].filter((n) => !incoming.has(n)).map((n) => [n, new Map([["", ""]])]));
  const MAX_RELATIONSHIP_DEPTH = 8;
  for (let pass = 0; pass < MAX_RELATIONSHIP_DEPTH; pass += 1) {
    let grew = false;
    for (const e of edges) {
      for (const [base, priorRule] of prefixes.get(e.from) ?? []) {
        const composed = joinRoute(base, e.prefix);
        const rule = [priorRule, e.rule].filter(Boolean).join(" + ");
        const values = prefixes.get(e.to) ?? new Map();
        if (!values.has(composed)) { values.set(composed, rule); prefixes.set(e.to, values); grew = true; }
      }
    }
    if (!grew) break;
  }

  const routes = new Map();   // "METHOD canonPath" -> {method, path, file}
  const locationKeys = new Set();
  for (const d of definitions) {
    // A route whose mount could not be resolved remains visible at its local
    // spelling. Silence would hide a true shadow; a guessed prefix invents one.
    for (const [prefix, propagatedRule] of prefixes.get(d.node) ?? [["", "local route"]]) {
      const path = joinRoute(prefix, d.path);
      const key = `${d.method} ${canonPath(path)}`;
      const location = { file: d.file, line: d.line, kind: 'definition', code_path: path,
        ...(d.unresolved && !registrarParameterNodes.has(d.node) ? { reason: d.unresolved } : {}) };
      if (!routes.has(key)) routes.set(key, { method: d.method, path, file: d.file, line: d.line, locations: [],
        rule: [propagatedRule, "local route"].filter(Boolean).join(" + "),
        ...(d.unresolved && !registrarParameterNodes.has(d.node) ? { reason: d.unresolved } : {}) });
      const locations = routes.get(key).locations;
      const locationKey = JSON.stringify([key, location.file, location.line, location.code_path]);
      if (!locationKeys.has(locationKey)) { locationKeys.add(locationKey); locations.push(location); }
    }
  }
  return [...routes.values()];
}

function walk(dir, out = [], depth = 0) {
  const scan = currentSourceScan(dir);
  if (scan) return scan.files(dir);
  if (depth > 7) return out;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github" && !(e.name === '.env' && e.isFile())) continue;
    if (SKIP.has(e.name)) continue;
    // The audit's own committed baseline (lib/ci.mjs — name inlined to avoid an
    // import cycle). Its details quote routes and files; scanning it as source
    // would let last run's findings feed this run's.
    if (e.name === LAYOUT.baseline.split("/").at(-1)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() || (e.isSymbolicLink() && SPEC_RE.test(e.name))) out.push(p);
  }
  return out;
}

/** Every API surface under a root: specs first, then spec-less services. */
export function findSurfaces(root, { includeFixtures = false } = {}) {
  return sourceMemo(root, ['surfaces', includeFixtures], () => findSurfacesUncached(root, { includeFixtures }));
}
function findSurfacesUncached(root, { includeFixtures = false } = {}) {
  const files = walk(root);
  const surfaces = [];
  const claimed = new Set();
  const excluded = [];

  for (const f of files) {
    if (!SPEC_RE.test(basename(f))) continue;
    let ops = 0;
    try { ops = operationsFrom(readContract(f).doc).length; } catch { continue; }
    if (!ops) continue;
    const dir = dirname(f).replace(/\/(docs|api|spec|openapi)$/, "");
    if (!includeFixtures && FIXTURE_PATH.test(toPosix(f))) {
      excluded.push({ contract: f, reason: "under a fixtures/examples path" });
      claimed.add(dir);
      continue;
    }
    surfaces.push({ dir, contract: f, kind: "documented", declared: ops });
    claimed.add(dir);
  }

  // Framework routes in a directory no spec covers.
  const undocumented = new Map();
  for (const f of files) {
    if (!/\.(py|ts|js|mjs|tsx|jsx)$/.test(f)) continue;
    if ([...claimed].some((c) => f.startsWith(`${c}/`))) continue;
    const src = sourceText(f); if (src === null) continue;
    for (const [re, kind] of FRAMEWORK_SIGNALS) {
      const n = (src.match(re) ?? []).length;
      if (!n) continue;
      // Attribute to the nearest sensible service root.
      const svc = dirname(dirname(f)) || dirname(f);   // portable: manual "/" splitting breaks on Windows
      const cur = undocumented.get(svc) ?? { dir: svc, kind: "undocumented", framework: kind, routes: 0 };
      cur.routes += n;
      undocumented.set(svc, cur);
    }
  }
  for (const u of undocumented.values()) {
    if (u.routes < 2) continue;
    if (!includeFixtures && FIXTURE_PATH.test(`${toPosix(u.dir)}/`)) {
      excluded.push({ contract: u.dir, reason: "under a fixtures/examples path" });
      continue;
    }
    surfaces.push(u);
  }
  surfaces.excluded = excluded;
  return surfaces;
}

// --- ownership, harvested --------------------------------------------------

export function readCodeowners(repoRoot) {
  for (const p of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const f = join(repoRoot, p);
    if (!existsSync(f)) continue;
    const rules = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const clean = line.replace(/#.*$/, "").trim();
      if (!clean) continue;
      const [pattern, ...owners] = clean.split(/\s+/);
      if (owners.length) rules.push({ pattern, owners });
    }
    return { file: p, rules };
  }
  return null;
}

const matchesPattern = (pattern, path) => {
  const p = pattern.replace(/^\//, "").replace(/\/$/, "");
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*")}(/|$)`);
  return re.test(path.replace(/^\//, ""));
};

/**
 * Owner for a path. CODEOWNERS is authoritative because a human maintained it
 * for another purpose. Otherwise git, weighted toward recent activity — the
 * last committer is often a typo fix, and the original author may have left.
 */
export function ownerFor(repoRoot, path, codeowners) {
  const rel = relative(repoRoot, path) || ".";
  if (codeowners) {
    const hit = [...codeowners.rules].reverse().find((r) => matchesPattern(r.pattern, rel));
    if (hit) return { owner: hit.owners.join(" "), source: `CODEOWNERS (${codeowners.file})` };
  }
  try {
    const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const recent = execFileSync("git", ["log", `--since=${since}`, "--format=%an", "--", rel],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
    const all = execFileSync("git", ["log", "--format=%an", "--", rel],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
    const score = new Map();
    for (const a of all) score.set(a, (score.get(a) ?? 0) + 1);
    for (const a of recent) score.set(a, (score.get(a) ?? 0) + 2);   // recency counts double
    const top = [...score].sort((a, b) => b[1] - a[1])[0];
    if (!top) return { owner: null, source: null };
    return { owner: top[0],
      source: recent.length ? "git, active last 12mo" : "git, no recent activity" };
  } catch { return { owner: null, source: null }; }
}

// --- edges: who calls whom -------------------------------------------------
//
// A node list is an inventory, and nobody shares an inventory. The
// map is the value, and its edges are derivable rather than declared: a consumer
// names an upstream by its base URL, and every surface already advertises its
// own base URL. Match host:port and the edge falls out. No manifest, no
// curation — curation is the kill switch.
//
// This finds the edge that matters most: an HTTP call across a repo boundary,
// whose upstream can change without any commit landing in the consumer.

// URLs a consumer's source names: literal, or an env-var default
// (process.env.X ?? "http://host:port"), which is the idiomatic form.
const URL_IN_SOURCE = /https?:\/\/[A-Za-z0-9.\-]+(?::\d+)?(?:\/[^\s'"`)]*)?/g;

const hostPort = (u) => { try { const x = new URL(u); return `${x.hostname}:${x.port || (x.protocol === "https:" ? 443 : 80)}`; } catch { return null; } };

// A dependency manifest's LOCK file is not source. It is a record of what a
// package manager downloaded, and it names registry, funding and homepage
// hosts by the hundred (one real repo: 237 mentions of registry.npmjs.org).
// None of them is an API this code calls, and on a consumer-only map — where
// the external list IS the whole artifact — they are the rows a reader
// notices, which costs the map its credibility on first sight. Excluded by
// FILE, never by a host blocklist: a blocklist has to guess, and guessing
// wrong hides a real dependency, which is the failure that matters.
const LOCKFILE = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
  "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "Pipfile.lock",
  "composer.lock", "Gemfile.lock", "go.sum", "deno.lock", "uv.lock"]);

// Versioned design exports are committed review artifacts, not application
// source. Some carry a generated browser runtime with CDN URL constants; those
// constants describe how the prototype can render when opened, not an outbound
// dependency of the repository's shipped service. Scope by artifact path, not
// by host: a real runtime call to the same host elsewhere must remain visible.
const DESIGN_PROTOTYPE_PATH = /(?:^|\/)(?:[^/]+-design-v\d+|design[-_]?prototypes?)(?:\/|$)/i;

// A URL on a comment line is documentation — `// see https://vite.dev/config/`
// — not a call. One structural test covers every language this scan reads: the
// line opens with a comment marker, and nothing between it and the URL looks
// like code. Prose is allowed in that gap ("see", "@see", "docs:") because
// that is how humans write the link; a quote, a paren, an `=` or a backtick is
// not, because those are how a URL gets USED, and a commented-out line of real
// code (`// const API = "https://…"`) is still a dependency this repo is one
// uncomment away from — reporting it costs a reader nothing, hiding it costs
// them the thing they came for.
//
// The marker set is exactly the languages this scan reads, and no more. Every
// extra marker is paid for in recall: `--` (SQL, Lua), `;` (Lisp, asm) and
// `<!--` (HTML) belong to file types upstreamUrls never opens, so they filtered
// nothing real and cost the one shape that does occur in a .ts or .sh-in-a-
// template — a wrapped shell-out whose continuation line opens with a long
// flag (`curl -sS \` / `  --url https://api.example.test/…`). That hid a real
// outbound dependency, which is the failure that matters.
const COMMENT_LEAD = /(?:^|\n)[ \t]*(?:\/\/+|#+|\*)[^"'`(=\n]*$/;

// A URL in source is not a dependency. It is a dependency when something CALLS
// it or BINDS it as an endpoint.
//
// Found on the real tree, and it was the day-one demo surface: a content site
// (guides for people leaving a religion) was reported as "calling" 988lifeline
// .org, rainn.org, cdc.gov and twenty other hosts, because those hyperlinks sit
// in `src/data/guides/*.js`. 99 of 103 external claims across ~/personal were
// that shape. An auditor whose first screen is mostly wrong gets closed, so a
// URL must earn the claim.
//
// Two ways it earns it, both requiring the URL to sit in a calling or binding
// CONTEXT rather than merely existing:
//   called  — fetch/axios/got/request/http.get/urllib/curl within reach of it
//   bound   — assigned to something named like an endpoint (API_URL, baseUrl,
//             endpoint, host, origin, webhook), or a config key of that shape
// Four shapes earn the claim. They are deliberately different rules, because a
// bare `=` is unambiguous while a bare `:` is not.
//
//   CALL   an HTTP client, with real call syntax after it. The syntax matters:
//          matching the word `request` alone made the prose "Requests to resign
//          membership', href: 'https://…'" read as an outbound call.
//   ASSIGN `= "https://…"`. An assignment to ANY name is a binding —
//          `const UPSTREAM = "https://api.example.test"` names no url-ish token and
//          is obviously a dependency.
//   PROP   `key: "https://…"` ONLY when the key is endpoint-ish. This is the
//          ambiguous one: `baseUrl:` in a config object is a dependency,
//          `href:`/`link:`/`src:` in a list of content links is not, and the
//          key name is the only thing separating them.
//   FLAG   `--url https://…`, the wrapped shell-out form.
// Scoped to the CURRENT LINE, which is what makes the ambiguous cases separate.
// `const CATALOG_URL = process.env.CATALOG_URL ?? "http://…"` keeps its `=` on
// the same line as the URL, so an assignment anywhere in the line prefix counts.
// A content link inside a multi-line array — `{ label: '…', href: 'https://…' }`
// — has its `=` on the line that opened the array, lines above, so the entry
// line carries no assignment and is correctly not a dependency.
const CALL_CONTEXT = /(?:fetch|axios|got|superagent|urlopen|urllib|httpx|HttpClient|RestTemplate|WebClient|HttpURLConnection|okhttp|requests?|curl|wget)\s*(?:\.[A-Za-z_]+)?\s*[([]/i;
const DIRECT_HTTP_CALL = /(?:fetch|axios|got|superagent|urlopen|urllib|httpx|HttpClient|RestTemplate|WebClient|HttpURLConnection|okhttp|requests?)\s*(?:\.[A-Za-z_]+)?\s*\(\s*f?["'`]$/i;
// A path construction alone is a binding, not proof of an outbound call.
// Keep the existing direct clients and getJson wrapper; an unrecognized
// wrapper remains visible as a stack reference without an operation claim.
const REQUEST_EXPRESSION = /\b(?:fetch|axios|got|superagent|urlopen|urllib|httpx|HttpClient|RestTemplate|WebClient|HttpURLConnection|okhttp|requests?|getJson|[A-Za-z_$][\w$]*\.request)\s*(?:\.[A-Za-z_]+)?\s*\(\s*(?:\{\s*["']?url["']?\s*:\s*)?f?["'`]?$/i;
function requestExpression(src, index) {
  const before = src.slice(Math.max(0, index - 200), index);
  return !COMMENT_LEAD.test(before) && REQUEST_EXPRESSION.test(before);
}
// Outbound scans keep character offsets while excluding commented examples.
// Quote contents stay intact, including the // inside a literal HTTP URL.
function withoutSourceComments(src, file) {
  const chars = src.split('');
  let quote = null;
  const hashComments = /\.(py|rb|env|ya?ml|toml)$/.test(file);
  const slashComments = !hashComments;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ((slashComments && c === '/' && next === '/') || (hashComments && c === '#')) {
      while (i < src.length && src[i] !== '\n') chars[i++] = ' ';
    } else if (slashComments && c === '/' && next === '*') {
      chars[i++] = ' '; chars[i] = ' ';
      while (++i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') { chars[i++] = ' '; chars[i] = ' '; break; }
        if (src[i] !== '\n' && src[i] !== '\r') chars[i] = ' ';
      }
    }
  }
  return chars.join('');
}
const ASSIGN_CONTEXT = /=/;
const ENDPOINT_KEY = /["']?[A-Za-z0-9_]*(?:url|uri|endpoint|origin|webhook|upstream|gateway)["']?\s*:/i;
const FLAG_CONTEXT = /--(?:url|endpoint|host|origin|server|base-?url)[=\s]/i;
// Node servers need an arbitrary absolute base to parse a relative incoming
// request URL. That parser fallback names no upstream. Keep actual outbound
// new URL('/resource', 'https://provider') construction eligible for scanning.
const INBOUND_URL_BASE = /\bnew\s+URL\s*\(\s*(?:req|request)\s*\.\s*(?:url|originalUrl)\s*,\s*["'`]$/;
function parserOnlyBase(before, src) {
  if (!INBOUND_URL_BASE.test(before) || CALL_CONTEXT.test(before)) return false;
  const assigned = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${INBOUND_URL_BASE.source}`).exec(before);
  // A proxy can build its outbound URL from req.url too. Preserve the base
  // when the resulting URL is then visibly passed to an HTTP client.
  if (assigned) {
    const name = assigned[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`${CALL_CONTEXT.source}\\s*${name}\\b`, "i").test(src)) return false;
  }
  return true;
}

/**
 * Does this URL sit in a calling or binding context on its own line?
 * `before` is the preceding source; only the current line is considered.
 */
function isDependencyContext(before) {
  const nl = before.lastIndexOf("\n");
  const line = nl === -1 ? before : before.slice(nl + 1);
  return ASSIGN_CONTEXT.test(line) || ENDPOINT_KEY.test(line) ||
         FLAG_CONTEXT.test(line) || CALL_CONTEXT.test(line);
}

/** Base URLs a service's source refers to, excluding its own. */
export function upstreamUrls(dir, ownBase, { omissions = [] } = {}) {
  const result = sourceMemo(dir, ['upstream-urls', ownBase ?? null], () => {
    const found = [];
    return { rows: upstreamUrlsUncached(dir, ownBase, { omissions: found }), omissions: found };
  });
  for (const row of result.omissions) if (!omissions.some(value => value.code === row.code && value.file === row.file)) omissions.push(row);
  return result.rows;
}
function upstreamUrlsUncached(dir, ownBase, { omissions = [] } = {}) {
  const own = ownBase ? hostPort(ownBase) : null;
  const seen = new Map();   // host:port -> {url, file}
  const locationKeys = new Set();
  for (const f of sourceFiles(dir)) {
    if (!/\.(py|ts|js|mjs|tsx|jsx|rb|go|ya?ml|env|toml|json)$/.test(f)) continue;
    if (TEST_FILE.test(toPosix(f))) continue;
    if (DESIGN_PROTOTYPE_PATH.test(toPosix(relative(dir, f)))) continue;
    if (LOCKFILE.has(basename(f))) continue;
    const raw = sourceText(f); if (raw === null) continue;
    const src = withoutSourceComments(raw, f);
    const lineAt = lineReader(src, f);
    for (const m of src.matchAll(URL_IN_SOURCE)) {
      // A port that is a runtime value — `http://127.0.0.1:${info.port}` — is
      // a port we do NOT know. The URL pattern stops at the `:`, leaving a
      // bare host that hostPort then resolves to the protocol default, and
      // everything downstream keys on host:port: an invented port invents a
      // node, and a service's own startup log becomes an upstream it calls.
      // Seen on the corpus, as `127.0.0.1:80` from src/server.mjs's listen
      // line. Unknowable is not the same as absent, so it is dropped.
      if (!/:\d/.test(m[0]) && /^:\D/.test(src.slice(m.index + m[0].length, m.index + m[0].length + 2))) continue;
      const hp = hostPort(m[0]);
      if (!hp || hp === own) continue;               // ignore self-references
      // Only the text back to the line start matters, and only its tail: slice
      // a bounded window so a 400KB file is not re-scanned per match.
      const before = src.slice(Math.max(0, m.index - 200), m.index);
      if (COMMENT_LEAD.test(before)) continue;
      if (parserOnlyBase(before, src)) {
        const file = relative(dir, f);
        if (!omissions.some(row => row.code === 'PARSER_ONLY_BASE_OMITTED' && row.file === file))
          omissions.push({ code: 'PARSER_ONLY_BASE_OMITTED', file,
            message: 'A base used only to parse an incoming request URL was omitted; no outbound request was inferred.' });
        continue;
      }
      // A .json/.yaml/.env config file IS the binding: a base URL declared there
      // is a dependency by construction, so context matching would only produce
      // false negatives. Source files must show a call or a binding.
      const isConfig = /\.(ya?ml|json|env|toml)$/.test(f);
      if (!isConfig && !isDependencyContext(before)) continue;
      const parsed = new URL(m[0]);
      const location = { file: relative(dir, f), line: lineAt(m.index),
        kind: isConfig ? 'config' : DIRECT_HTTP_CALL.test(before) ? 'request' : 'binding',
        path: parsed.pathname };
      if (!seen.has(hp)) seen.set(hp, { url: `${parsed.protocol}//${hp}`, file: location.file, line: location.line, locations: [] });
      const locations = seen.get(hp).locations;
      const locationKey = JSON.stringify([hp, location.file, location.line, location.kind, location.path]);
      if (!locationKeys.has(locationKey)) { locationKeys.add(locationKey); locations.push(location); }
    }
  }
  return [...seen.values()].map((v) => ({ ...v, hostPort: hostPort(v.url) }));
}

// --- operation-level edges -------------------------------------------------
//
// "gateway calls catalog" is a map; "gateway calls GET /events/{id}" is a
// contract between two repos, and the one an upstream can break with a commit
// the consumer never sees. The request paths sit NEXT TO the base-URL
// reference — in a template (`${CATALOG_URL}/events`), a concat, an f-string —
// or one helper away (const catalog = (path) => call("catalog", path)), so
// both are reached by binding names to the upstream they carry and reading the
// string that follows.
//
// Two rules keep this honest. Attribution needs positive evidence: a path is
// only tied to an upstream through a name that provably carries its base URL —
// a free-floating "/health" is never claimed, however well it would match. And
// a call only becomes an operation when the upstream's own contract declares
// it; everything else is reported as an unmatched call. Missing an operation
// is acceptable; inventing one is not.

const IDENT = "[A-Za-z_$][\\w$]{2,}";
// HTTP verbs as bare names are route DEFINITIONS in every framework; binding
// one would read the consumer's own routes as upstream calls.
const ALIAS_STOP = new Set(["get", "post", "put", "patch", "delete", "head",
  "options", "use", "all", "route", "fetch"]);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A call path, canonicalised: query dropped, every interpolation — JS `${x}`,
// f-string `{x}`, declared `{id}` — collapsed to the same `{}` canonPath uses.
const canonCall = (p) => canonPath(p.split("?")[0].replace(/\$\{[^}]*\}/g, "{}"));

// The HTTP method for a path literal found at [litStart, litEnd): a preceding
// `.post(`-style attribute call, or a `method: "POST"` inside the SAME call,
// else GET — the default of every HTTP client this scan understands.
//
// "Same call" is enforced by ending the forward window where the statement
// ends: at a `;`, where the enclosing call closes (bracket depth going
// negative), or at a newline that opens a new statement at depth 0 — the last
// two because semicolon-less code has no `;` to cut at, and a LATER
// statement's `method:` literal bleeding in would report a GET as something
// else, which can invent a declared operation the consumer never sends.
const STMT_START = /^\s*(?:const|let|var|return|await|async|if|for|while|function|class|import|export|throw|def)\b/;
function methodNear(src, litStart, litEnd) {
  const before = src.slice(Math.max(0, litStart - 48), litStart);
  const attr = /\.\s*(get|post|put|patch|delete|head|options|trace|connect)\s*\(\s*f?["'`]?$/i.exec(before);
  if (attr) return attr[1].toUpperCase();
  const ahead = src.slice(litEnd, litEnd + 300);
  let depth = 0, end = ahead.length;
  for (let i = 0; i < end; i += 1) {
    const c = ahead[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") { if ((depth -= 1) < 0) { end = i; break; } }
    else if (depth > 0) continue;
    else if (c === ";") { end = i; break; }
    else if (c === "\n" && STMT_START.test(ahead.slice(i + 1, i + 40))) { end = i; break; }
  }
  const options = ahead.slice(0, end);
  const opt = /\bmethod\s*[:=]\s*["'`](get|post|put|patch|delete|head|options|trace|connect)["'`]/i.exec(options);
  return opt ? opt[1].toUpperCase() : /\bmethod\s*[:=]/.test(options) ? null : "GET";
}

/**
 * Request paths a consumer's source sends to each upstream in `targets`
 * (host:port -> truthy). Names are bound to upstreams in rounds: first any
 * identifier or object key assigned an upstream URL literal, then aliases of
 * those (BASES = { catalog: CATALOG_URL }), then helper functions whose body
 * names a binding (const catalog = (path) => call("catalog", path)). Paths are
 * read where a binding and a literal meet; helper CALL SITES are read too,
 * but only for names bound as helpers — a value name used as a function is
 * how a stray `url("/x")` would invent an edge.
 */
export function upstreamCalls(dir, targets) {
  return sourceMemo(dir, ['upstream-calls', [...targets.keys()].sort()], () => upstreamCallsUncached(dir, targets));
}
function upstreamCallsUncached(dir, targets) {
  const sources = [];
  for (const f of sourceFiles(dir)) {
    if (!/\.(py|ts|js|mjs|tsx|jsx|rb|go)$/.test(f)) continue;
    if (TEST_FILE.test(toPosix(f))) continue;
    const raw = sourceText(f); if (raw === null) continue;
    const src = withoutSourceComments(raw, f);
    sources.push({ file: relative(dir, f), src, lineAt: lineReader(src, f) });
  }

  // Names belong to a source module. A same-named variable elsewhere is not
  // evidence of an import; only the existing explicit named-import resolver
  // connects modules. A conflicting assignment is retained as unresolved.
  const symbols = moduleSymbols(sources);
  const bindings = new Map(sources.map(({ file }) => [file, new Map()]));
  const helperBindings = new Map(sources.map(({ file }) => [file, new Map()]));
  // The small scanner does not resolve lexical values. If a parameter shadows
  // a module binding, reject that name throughout the file rather than borrow
  // the outer URL for a call whose actual provider is a runtime argument.
  const shadowed = new Map(sources.map(({ file, src }) => {
    const params = [...src.matchAll(/\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)|\(([^)]*)\)\s*(?::[^=\n]+)?=>|\b([A-Za-z_$][\w$]*)\s*=>|\bdef\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)]
      .flatMap(match => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').split(',')
        .flatMap(param => param.split('=')[0].match(/[A-Za-z_$][\w$]*/g) ?? []));
    return [file, new Set(params)];
  }));
  const provenHttpHelpers = new Map(sources.map(({ file, src }) => [file,
    new Set(functionScopes(src, file).filter(scope => CALL_CONTEXT.test(src.slice(scope.open + 1, scope.end))).map(scope => scope.name))]));
  const localDeclarations = new Map(sources.map(({ file, src }) => [file,
    new Set([...src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]))]));
  const same = (a, b) => a?.hostPort === b?.hostPort && a?.base_path === b?.base_path;
  const bind = (map, name, value) => {
    if (ALIAS_STOP.has(name.toLowerCase()) || value === undefined) return false;
    if (!map.has(name)) { map.set(name, value); return true; }
    if (map.get(name) !== null && !same(map.get(name), value)) { map.set(name, null); return true; }
    return false;
  };
  const urlBinding = literal => {
    try {
      const url = new URL(literal);
      const hp = hostPort(literal);
      if (!hp || !targets.has(hp) || hasInterpolation(url.pathname)) return null;
      return { hostPort: hp, base_path: url.pathname.replace(/\/+$/, '') };
    } catch { return null; }
  };
  const urlBind = new RegExp(`\\b(${IDENT})\\s*[:=]\\s*[^;\\n]*?["'\`](https?://[A-Za-z0-9.\\-]+(?::\\d+)?(?:/[^\\s"'\`]*)?)`, 'g');
  for (const { file, src } of sources) {
    for (const m of src.matchAll(urlBind)) bind(bindings.get(file), m[1], shadowed.get(file).has(m[1]) ? null : urlBinding(m[2]));
  }

  // Bounded propagation of explicit imports, aliases and the already-supported
  // one-line helper form. There is no repository-global name fallback.
  for (let round = 0; round < 8; round += 1) {
    let grew = false;
    for (const { file, src } of sources) {
      const bound = bindings.get(file), helpers = helperBindings.get(file);
      for (const [key, imported] of symbols.imports) {
        if (!key.startsWith(`${file}::`) || !imported) continue;
        const localName = key.slice(file.length + 2);
        if (localDeclarations.get(file).has(localName) || shadowed.get(file).has(localName)) continue;
        const exported = symbols.exports.get(imported.file)?.get(imported.exported);
        if (!exported) continue;
        if (provenHttpHelpers.get(imported.file)?.has(exported) && !provenHttpHelpers.get(file).has(localName)) {
          provenHttpHelpers.get(file).add(localName); grew = true;
        }
        if (bind(bound, localName, bindings.get(imported.file)?.get(exported))) grew = true;
        if (bind(helpers, localName, helperBindings.get(imported.file)?.get(exported))) grew = true;
      }
      for (const m of src.matchAll(new RegExp(`\\b(${IDENT})\\s*:\\s*(${IDENT})\\b`, 'g')))
        if (bind(bound, m[1], shadowed.get(file).has(m[1]) ? null : bound.get(m[2]))) grew = true;
      for (const m of src.matchAll(new RegExp(`\\b(${IDENT})\\s*=\\s*(${IDENT})\\s*[;,)\\n]`, 'g')))
        if (bind(bound, m[1], shadowed.get(file).has(m[1]) ? null : bound.get(m[2]))) grew = true;
      const names = [...bound.keys()];
      if (!names.length) continue;
      const boundWord = new RegExp(`\\b(${names.map(escRe).join('|')})\\b`, 'g');
      const arrow = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*(.+)`, 'g');
      for (const m of src.matchAll(arrow)) {
        if (!m[2].trim()) continue;
        const body = m[3].split(';')[0];
        const invokesHttp = CALL_CONTEXT.test(body) || /\bgetJson\s*\(/i.test(body) ||
          [...provenHttpHelpers.get(file)].some(name => new RegExp(`\\b${escRe(name)}\\s*\\(`).test(body));
        if (!invokesHttp || shadowed.get(file).has(m[1])) continue;
        if (!provenHttpHelpers.get(file).has(m[1])) { provenHttpHelpers.get(file).add(m[1]); grew = true; }
        const values = [...body.matchAll(boundWord)].map(match => bound.get(match[1]));
        if (values.length) {
          const value = values.every(item => item && same(item, values[0])) ? values[0] : null;
          if (bind(helpers, m[1], value)) grew = true;
        }
      }
    }
    if (!grew) break;
  }

  const calls = new Map();
  const grouped = new Map();
  const locationKeys = new Set();
  const add = (binding, method, path, file, line, resetBase = false, kind = 'request') => {
    if (!binding || !method || !path.startsWith('/')) return;
    const canon = canonCall(path), codePath = path.split('?')[0];
    const hp = binding.hostPort;
    const key = `${hp} ${method} ${canon}`;
    const basePath = resetBase ? '' : binding.base_path;
    const location = { file, line, kind, code_path: codePath, base_path: basePath,
      request_path: joinRoute(basePath, canon) };
    let row = grouped.get(key);
    if (!row) {
      row = { method, path: canon, file, line, locations: [] };
      grouped.set(key, row);
      (calls.get(hp) ?? calls.set(hp, []).get(hp)).push(row);
    }
    const locationKey = JSON.stringify([key, file, line, kind, codePath, basePath]);
    if (!locationKeys.has(locationKey)) { locationKeys.add(locationKey); row.locations.push(location); }
  };
  const INTERP = "(?:\\$\\{[^}]*\\}|[^\"'`\\n])*";
  for (const { file, src, lineAt } of sources) {
    const bound = bindings.get(file), helpers = helperBindings.get(file);
    for (const [name, binding] of bound) {
      if (!binding) continue;
      const n = escRe(name);
      const patterns = [
        [new RegExp(`\\$?\\{\\s*${n}\\s*\\}(${INTERP})`, 'g'), false],
        [new RegExp(`\\b${n}\\s*\\+\\s*["'\`](/[^"'\`\\n]*)`, 'g'), false],
        [new RegExp(`new\\s+URL\\(\\s*["'\`](/[^"'\`]*)["'\`]\\s*,\\s*${n}\\b`, 'g'), true],
      ];
      for (const [re, resetBase] of patterns)
        for (const m of src.matchAll(re))
          add(binding, methodNear(src, m.index, m.index + m[0].length), m[1], file, lineAt(m.index), resetBase,
            requestExpression(src, m.index) ? 'request' : 'binding');
    }
    for (const [name, binding] of helpers) {
      if (!binding) continue;
      const n = escRe(name);
      const call = new RegExp(`(?<![.\\w$])${n}\\s*\\(\\s*(?:"(/[^"\\n]*)"|'(/[^'\\n]*)'|\`(/${INTERP})\`)`, 'g');
      for (const m of src.matchAll(call))
        add(binding, methodNear(src, m.index, m.index + m[0].length), m[1] ?? m[2] ?? m[3], file, lineAt(m.index));
    }
    // An absolute literal in a supported HTTP call has the same location
    // evidence as the corresponding bound-base expression. Bindings alone do
    // not gain an operation merely because their URL contains a path.
    for (const m of src.matchAll(URL_IN_SOURCE)) {
      const before = src.slice(Math.max(0, m.index - 200), m.index);
      if (COMMENT_LEAD.test(before) || !DIRECT_HTTP_CALL.test(before)) continue;
      const binding = urlBinding(m[0]);
      if (binding) add(binding, methodNear(src, m.index, m.index + m[0].length), new URL(m[0]).pathname,
        file, lineAt(m.index), true);
    }
  }
  return calls;
}

/**
 * Derive edges between the surfaces. Each is (from -> to) with the file the
 * reference was found in, plus — when the upstream has a contract — WHICH of
 * its declared operations the consumer's source calls. Consumers pointing at a
 * base URL that is not one of the surfaces are reported as external upstreams,
 * not dropped.
 */
export function deriveEdges(surfaces, { omissions = [] } = {}) {
  // Map every surface's advertised base URL to the surface itself.
  const byHostPort = new Map();
  for (const s of surfaces) {
    const b = baseUrlFor(s.dir);
    const hp = b ? hostPort(b) : null;
    if (hp) byHostPort.set(hp, s);
  }
  const edges = [];
  const external = [];
  for (const s of surfaces) {
    const from = s.name ?? basename(s.dir);
    const own = baseUrlFor(s.dir);
    const ups = upstreamUrls(s.dir, own, { omissions });
    const targets = new Map(ups.filter((u) => byHostPort.has(u.hostPort)).map((u) => [u.hostPort, true]));
    const calls = targets.size ? upstreamCalls(s.dir, targets) : new Map();
    for (const up of ups) {
      const t = byHostPort.get(up.hostPort);
      const to = t ? (t.name ?? basename(t.dir)) : null;
      if (to && to !== from) {
        const e = { from, to, via: up.file };
        const found = calls.get(up.hostPort) ?? [];
        if (found.length && t.contract) {
          // A call becomes an operation only by matching the upstream's OWN
          // declaration — the declared spelling is reported, never the call's.
          let declared = null;
          try {
            declared = new Map();
            // Contracts have been seen declaring the same route twice ("/featured"
            // and "/featured/"); the first declaration is the primary spelling.
            for (const o of operationsFrom(readContract(t.contract).doc)) {
              const k = `${o.method} ${canonPath(o.path)}`;
              if (!declared.has(k)) declared.set(k, o.op);
            }
          } catch { declared = null; }
          if (declared) {
            const ops = new Set(), unmatched = new Set();
            for (const c of found) {
              const key = `${c.method} ${canonPath(c.path)}`;
              if (declared.has(key)) ops.add(declared.get(key));
              else unmatched.add(`${c.method} ${c.path}`);
            }
            if (ops.size) e.operations = [...ops].sort();
            if (unmatched.size) e.unmatchedCalls = [...unmatched].sort();
          }
        }
        edges.push(e);
      }
      else if (!to) external.push({ from, url: up.url, via: up.file });
    }
  }
  return { edges, external };
}

// --- probing ---------------------------------------------------------------

export const baseUrlFor = (dir) => {
  const cfg = resolveConfig(dir);
  return cfg.problems.length || cfg.baseUrlSource === "fallback" ? null : cfg.baseUrl;
};

// responseFindings can return no findings because a comparison passed OR
// because nothing was comparable. Coverage must distinguish those outcomes.
// Keep this predicate aligned with its status check and compareShape's
// supported top-level kinds; default-only statuses, unsupported schemas and
// null/non-JSON bodies do not establish a successful comparison.
function successfulResponseCompared(doc, path, body) {
  const statuses = declaredStatuses(doc, "GET", path);
  if (statuses && !statuses.includes("default")) return true;
  if (body === undefined || body === null) return false;
  const schema = responseSchema(doc, "GET", path);
  let kind = schema?.type;
  if (Array.isArray(kind)) kind = kind.find((value) => value !== "null");
  if (!kind && schema?.properties) kind = "object";
  return ["object", "array", "string", "number", "integer", "boolean"].includes(kind);
}

/** Probe documented read operations and report where server and contract disagree. */
export async function probe(surface, { limit = 40, timeoutMs = 4000 } = {}) {
  const cfg = resolveConfig(surface.dir);
  const base = cfg.problems.length || cfg.baseUrlSource === "fallback" ? null : cfg.baseUrl;
  if (!base) return { reachable: null, attempted: 0, checked: 0, operations_probed: 0, findings: [], observed: [] };
  const { doc } = readContract(surface.contract);
  const ops = operationsFrom(doc);
  const reads = ops.filter((o) => o.method === "GET" && !o.path.includes("{")).slice(0, limit);
  const findings = [];
  const observed = [];               // per-op shape facts, for the baseline pass
  const conventions = [];            // per-op convention facts, for consistency
  const bodies = new Map();          // path -> parsed 2xx body, for id sampling
  let attempted = 0, checked = 0, reachable = false;
  // `checked` counts REQUESTS: one documented operation can be requested up to
  // three times below (bare GET, sampled id, nonexistent id). Coverage is a
  // question about OPERATIONS — "how much of the contract did we actually
  // compare" — so completed comparisons are tracked separately from responses.
  // Any renderer that divided `checked` by the declared count
  // would report more coverage than was measured.
  //
  // An operation joins this set only when its response was COMPARED against
  // the contract, which is the claim the map makes about it ("every probed
  // operation matched its contract"). Only comparable responses or explicit
  // disagreement findings in the first two passes qualify. The third
  // pass below asks for an id that cannot exist purely to see how the service
  // says "no"; it says of itself that "the 404 itself proves nothing (never a
  // finding)", so an operation reached only that way was never checked against
  // anything and must not be counted as covered. Measured: a contract of
  // `GET /venues` + `GET /venues/{id}` whose collection comes back empty has
  // no id to sample, so the templated operation is requested exactly once,
  // with `x-audit-nonexistent-id`, and produces no finding and no observed
  // shape — counting it would let the map report "2 of 2 probed" with one of
  // the two never compared.
  const probedOps = new Set();

  for (const { op, path } of reads) {
    let res;
    attempted += 1;
    try {
      res = await fetch(new URL(base + path), { method: "GET", redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs) });
    } catch { continue; }
    reachable = true; checked += 1;
    if (res.status >= 300 && res.status < 400) {
      probedOps.add(op);
      const loc = res.headers.get("location");
      findings.push({ op, kind: "redirect",
        detail: `documented at ${path}; server ${res.status} → ${loc ? new URL(loc, base + path).pathname : "?"}` });
      continue;
    }
    if (res.status >= 500) { probedOps.add(op); findings.push({ op, kind: "erroring", detail: `documented but the server returns ${res.status}` }); continue; }

    const text = await res.text().catch(() => "");
    let body; try { body = JSON.parse(text); } catch { body = undefined; }
    conventions.push(observeResponse({ op, path, status: res.status, body }));

    if (res.status === 404) { probedOps.add(op); findings.push({ op, kind: "missing", detail: `documented but the server returns 404` }); continue; }
    if (res.status >= 200 && res.status < 300) {
      if (body !== undefined) bodies.set(path, body);
      const compared = responseFindings({ op, method: "GET", path, doc, status: res.status, headers: res.headers, body });
      findings.push(...compared);
      if (compared.length || successfulResponseCompared(doc, path, body)) probedOps.add(op);
      if (body !== undefined)
        observed.push({ op, hash: shapeHash(body), rows: (rowsOf(body) ?? rowsAnywhere(body))?.length ?? null, full: pageFull(body) });
    } else {
      const reject = bareRejectionFinding({ op, method: "GET", path, doc, status: res.status, bodyText: text });
      if (reject) { probedOps.add(op); findings.push(reject); }
    }
  }

  // Parameterised reads, with an id sampled from the collection fetched above.
  // A sampled probe reports what its own response proves (5xx, Deprecation,
  // schema contradiction) and one thing more: a 404. That 404 is trustworthy
  // here precisely because the id was lifted from the service's OWN live
  // collection moments ago — it is not a stale sample, so a 404 on the
  // substituted path is the documented ROUTE missing, not a vanished row. This
  // closes missing-op recall on documented sub-resources like
  // GET /venues/{id}/layout, which the non-templated GET pass structurally skips.
  // The finding names the operation, the operation that listed the id and the
  // field it came from, never the id: it is a response value, and findings
  // reach the map page, its JSON and text, the audit output and the committed
  // baseline. The parenthesised source keeps the baseline key of findings
  // accepted when the id was printed (lib/ci.mjs normDetail).
  const paramReads = ops.filter((o) => o.method === "GET" && (o.path.match(/\{/g) ?? []).length === 1).slice(0, limit);
  const declared = paramReads.length ? declaredPropertyNames(doc) : undefined;
  for (const { op, path } of paramReads) {
    const sample = sampledId(path, bodies, { declared });
    if (!sample) continue;
    const id = sample.id;
    let res;
    attempted += 1;
    try {
      res = await fetch(new URL(base + path.replace(/\{[^}]+\}/, encodeURIComponent(id))), {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch { continue; }
    reachable = true; checked += 1;
    if (res.status >= 500) {
      probedOps.add(op);
      findings.push({ op, kind: "erroring",
        detail: `server returns ${res.status} for a listed id (${listedIdSource(sample)})` });
      continue;
    }
    if (res.status === 404) {
      probedOps.add(op);
      findings.push({ op, kind: "missing",
        detail: `documented but the server returns 404 for a listed id (${listedIdSource(sample)})` });
      continue;
    }
    if (res.status < 200 || res.status >= 300) continue;
    let body; try { body = JSON.parse(await res.text()); } catch { body = undefined; }
    const compared = responseFindings({ op, method: "GET", path, doc, status: res.status, headers: res.headers, body });
    findings.push(...compared);
    if (compared.length || successfulResponseCompared(doc, path, body)) probedOps.add(op);
    if (body !== undefined) {
      observed.push({ op, hash: shapeHash(body), rows: null, full: false });
      conventions.push(observeResponse({ op, path, status: res.status, body }));
    }
  }

  // The error-envelope convention is only observable in an error, and sampled
  // ids answer 200. A GET with an id that cannot exist is the one read-only way
  // to see how this service says "no" — the response's SHAPE is the fact taken;
  // the 404 itself proves nothing (never a finding), and a 5xx here is a crash
  // handler, which observeResponse already refuses to read as a convention.
  for (const { op, path } of paramReads.slice(0, 8)) {
    let res;
    attempted += 1;
    try {
      res = await fetch(new URL(base + path.replace(/\{[^}]+\}/, "x-audit-nonexistent-id")), {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch { continue; }
    reachable = true; checked += 1;   // a request, deliberately NOT coverage: see probedOps
    if (res.status < 400 || res.status >= 500) continue;
    let body; try { body = JSON.parse(await res.text()); } catch { continue; }
    conventions.push(observeResponse({ op, path, status: res.status, body }));
  }

  return { reachable: checked ? reachable : null, base,
           environment: cfg.name ?? null,
           base_url_source: cfg.baseUrlOverride ? "API_BASE_URL"
             : cfg.baseUrlSource === "config" ? "environment" : cfg.baseUrlSource,
           attempted, checked, operations_probed: probedOps.size, findings, observed,
           conventions: conventions.filter(Boolean) };
}

export async function auditSurface(surface, { execute = true, recordBaselines = false } = {}) {
  // Which repository this surface actually lives in. Reported, not interpreted:
  // a surface in a repo of its own is a separate checkout, and the reader can
  // see that without the audit guessing at ownership on their behalf.
  const repoRoot = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"],
        { cwd: surface.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return surface.dir; }
  })();
  const codeowners = readCodeowners(repoRoot);
  const { owner, source } = ownerFor(repoRoot, surface.contract ?? surface.dir, codeowners);
  const ctx = loadContext(surface.dir);
  // Confidence is graded against the contract on disk, not the digest stored
  // at the last init/learn — the audit is exactly the reader who must see an
  // edit nobody re-learned.
  const contractDigest = ctx ? liveContractDigest(repoRoot, ctx) : null;
  const known = ctx ? Object.entries(ctx.operations).reduce((a, [, e]) => {
    a[confidenceFor(e, repoRoot, contractDigest)] += 1; return a;
  }, { verified: 0, suspect: 0, unverified: 0 }) : null;

  // Coverage is a ratio against a contract's DECLARED operations. A surface
  // with no contract has nothing to be probed against, so it reports no
  // coverage at all — a zero here would be divided by that service's route
  // count and rendered as "0 of N documented operations", which is what its
  // routes are precisely not. `--no-execute` on a contracted surface is the
  // other case and does report zero: there was something to probe, and nothing
  // was asked.
  const { observed = [], conventions = [], ...probed } = execute && surface.contract
    ? await probe(surface)
    : { reachable: null, attempted: 0, checked: 0, findings: [],
        ...(surface.contract ? { operations_probed: 0 } : {}) };
  const inRepo = existsSync(join(repoRoot, ".git"));

  // Consistency with yourself: cluster the conventions this
  // service's own responses follow and flag the minority endpoint. Only
  // observation can power this — an unreachable service accumulates nothing
  // and is flagged for nothing.
  probed.findings.push(...serviceConsistency(conventions));

  // Write-path status codes are checked in the handler source, never by
  // executing the write. Shape baselines are always COMPARED against whatever
  // sannr.json already records (learn writes shape hashes too); they are
  // only RECORDED under --baseline, into an sannr.json that already
  // exists — the audit surveys other people's repos, and a surveyor neither
  // leaves files behind nor edits them uninvited.
  if (surface.contract) {
    try {
      const { doc } = readContract(surface.contract);
      probed.findings.push(...staticStatusFindings(surface.dir, doc));
    } catch { /* a contract the parser cannot read costs the check, not the audit */ }
  }
  if (ctx && observed.length) {
    const { findings, dirty } = baselineFindings(ctx, observed);
    probed.findings.push(...findings);
    if (dirty && recordBaselines) try { saveContext(surface.dir, ctx); } catch { /* read-only checkout */ }
  }

  // Shadow routes: live code routes a documented service's own spec never
  // declares. The single most valuable audit finding and the one the old scan
  // structurally could not reach, because it only looked at spec-less services.
  let shadowRoutes = [];
  if (surface.contract) {
    let declared = new Set();
    try {
      for (const o of operationsFrom(readContract(surface.contract).doc))
        declared.add(`${o.method} ${canonPath(o.path)}`);
    } catch { declared = null; }
    if (declared) {
      for (const r of extractRoutes(surface.dir)) {
        const key = `${r.method} ${canonPath(r.path)}`;
        if (declared.has(key)) continue;
        shadowRoutes.push({ ...r, infra: INFRA_ROUTE.test(r.path) });
      }
    }
  }
  const shadow = shadowRoutes.filter((r) => !r.infra);

  // Root-cause dedup runs last, over the whole assembled set: only responseFindings
  // emits schema-mismatch, but collapsing here keeps the policy in one place and
  // the per-op probe output (which the probe tests pin) untouched.
  probed.findings = dedupeSchemaMismatch(probed.findings);

  return { ...surface, name: basename(surface.dir), repoRoot,
           repo: inRepo ? basename(repoRoot) : null,
           owner, ownerSource: source, hasContext: Boolean(ctx), known,
           // The summary (not the raw observations) travels with the surface so
           // the platform pass can compare services that call each other.
           conventions: conventions.length ? serviceSummary(conventions) : null,
           shadowRoutes, shadowCount: shadow.length, ...probed };
}
