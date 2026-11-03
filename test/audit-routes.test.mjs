// Extracting routes from source is how the audit finds a shadow endpoint — a
// live route inside a service whose spec looks complete.
//
//   node --test test/audit-routes.test.mjs
//
// The corpus scored this at 1.00 precision. Real repos immediately produced two
// false-positive classes the corpus could not: a test file's `/widgets/${id}`
// and a prefix-mounted router's bare `/{id}`. Both are guarded here, because a
// route auditor that cries wolf gets ignored, and an ignored auditor never
// surfaces the admin backdoor it exists to find.

import { test } from "node:test";
import assert from "node:assert/strict";
import { auditSurface, canonPath, extractRoutes } from "../lib/audit.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createSourceScan, withSourceScan } from '../lib/source-scan.mjs';
import { tmpdir } from "node:os";
import { join } from "node:path";

function service(files) {
  const dir = mkdtempSync(join(tmpdir(), "routes-test-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}
const has = (routes, method, path) =>
  routes.some((r) => r.method === method && r.path === path);

test("inline hono/express routes are extracted with their paths", () => {
  const dir = service({ "src/server.mjs": `
    app.get("/tags", (c) => c.json([]));
    app.post("/admin/reindex", (c) => c.json({}));
    app.get("/events/:id", (c) => c.json({}));
  ` });
  const r = extractRoutes(dir);
  assert.ok(has(r, "GET", "/tags"));
  assert.ok(has(r, "POST", "/admin/reindex"));
  assert.ok(has(r, "GET", "/events/:id"), "path params are kept, canonicalised at compare time");
});

test("routes in TEST files are not real routes", () => {
  const dir = service({
    "src/app.ts": `app.get("/real", h);`,
    "src/app.test.ts": `client.get("/widgets/fixture"); expect(...)`,
    "test/e2e.mjs": `api.post("/only-in-a-test", {});`,
  });
  const r = extractRoutes(dir);
  assert.ok(has(r, "GET", "/real"));
  assert.ok(!r.some((x) => x.path.includes("fixture")), "a test's HTTP call is not a route definition");
  assert.ok(!r.some((x) => x.path === "/only-in-a-test"));
});

test("template-interpolated paths are skipped, not reported as literal routes", () => {
  const dir = service({ "src/app.ts": "app.get(`/widgets/${widget.id}`, h); app.get('/static', h);" });
  const r = extractRoutes(dir);
  assert.ok(!r.some((x) => x.path.includes("$")), "an unresolved interpolation is not a knowable path");
  assert.ok(has(r, "GET", "/static"));
});

test("a FastAPI router prefix is resolved so sub-routes get their real path", () => {
  const dir = service({ "app/routers/deliveries.py": `
    router = APIRouter(prefix="/deliveries", tags=["deliveries"])
    @router.get("/")
    def list(): ...
    @router.get("/{delivery_id}")
    def get(): ...
  ` });
  const r = extractRoutes(dir);
  assert.ok(has(r, "GET", "/deliveries/{delivery_id}"),
    "the bare /{delivery_id} must resolve to the mounted path, or it looks undocumented");
  assert.ok(!has(r, "GET", "/{delivery_id}"), "the un-prefixed form must not be reported");
});

test("a Hono basePath prefix is resolved", () => {
  const dir = service({ "src/api.mjs": `
    const api = new Hono().basePath("/v1");
    api.get("/flags", (c) => c.json({}));
  ` });
  assert.ok(has(extractRoutes(dir), "GET", "/v1/flags"));
});

test("nested Express mounts compose only onto their own router's routes", async () => {
  const dir = service({
    "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      info: { title: "nested mounts", version: "1" },
      paths: {
        "/api/v1/parents/{parentId}/children": {
          get: { responses: { 200: { description: "documented mounted route" } } },
        },
        "/ops/jobs": {
          get: { responses: { 200: { description: "documented sibling router" } } },
        },
      },
    }),
    "src/app.mjs": `
      export function createApp() {
        const app = express();
        app.get("/admin/reindex", handler);
        app.use("/api", createApiRouter());
        app.use("/ops", createOpsRouter());
        return app;
      }
    `,
    "src/api.mjs": `
      export function createApiRouter() {
        const router = Router();
        router.use("/v1", createParentRouter());
        return router;
      }
    `,
    "src/parents.mjs": `
      export function createParentRouter() {
        const router = Router();
        router.get("/parents/:parentId/children", handler);
        router.post("/parents/:parentId/export", handler);
        return router;
      }
    `,
    "src/ops.mjs": `
      export function createOpsRouter() {
        const router = Router();
        router.get("/jobs", handler);
        return router;
      }
    `,
  });

  const routes = extractRoutes(dir);
  assert.ok(has(routes, "GET", "/api/v1/parents/:parentId/children"),
    "both mount prefixes survive on the parameterized route");
  assert.equal(canonPath("/api/v1/parents/:parentId/children"),
    "/api/v1/parents/{}/children", "parameter normalization retains the composed prefix");
  assert.ok(has(routes, "GET", "/ops/jobs"), "the sibling router gets only its own prefix");
  assert.ok(!routes.some((r) => [
    "/parents/:parentId/children", "/api/jobs", "/ops/v1/parents/:parentId/children",
  ].includes(r.path)), `router prefixes crossed or were dropped: ${JSON.stringify(routes)}`);

  const audited = await auditSurface({
    dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 2,
  }, { execute: false });
  assert.deepEqual(audited.shadowRoutes.filter((r) => !r.infra)
    .map((r) => `${r.method} ${r.path}`).sort(), [
    "GET /admin/reindex",
    "POST /api/v1/parents/:parentId/export",
  ], "one true shadow and one mounted-but-undocumented route partition from documented mounts");
});

test("an aliased imported router instance keeps every repeated mount prefix", () => {
  const dir = service({
    "src/app.mjs": `
      import { router as itemsRouter } from "./items.mjs";
      app.use("/api/v1", itemsRouter);
      app.use("/legacy", itemsRouter);
    `,
    "src/items.mjs": `
      export const router = Router();
      router.get("/items/:itemId", handler);
    `,
  });
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "GET", "/api/v1/items/:itemId"));
  assert.ok(has(routes, "GET", "/legacy/items/:itemId"));
  assert.ok(!has(routes, "GET", "/items/:itemId"),
    `a mounted imported router leaked its local spelling: ${JSON.stringify(routes)}`);
});

test("an arbitrary named *Router instance keeps its mounted true shadow", () => {
  const dir = service({
    "src/app.mjs": `
      import { itemsRouter } from "./items.mjs";
      app.use("/api", itemsRouter);
    `,
    "src/items.mjs": `
      export const itemsRouter = Router();
      itemsRouter.get("/secret/:itemId", handler);
      apiClient.get("/remote/items/:itemId");
    `,
  });
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "GET", "/api/secret/:itemId"),
    `the mounted true shadow disappeared: ${JSON.stringify(routes)}`);
  assert.ok(!has(routes, "GET", "/secret/:itemId"));
  assert.ok(!routes.some((r) => r.path.includes("/remote/items")),
    "expanding *Router receivers must not turn client calls into route definitions");
});

test("a Router-suffixed Axios client is not a server route", () => {
  const dir = service({
    "src/client.mjs": `
      const clientRouter = axios.create({ baseURL: "https://api.example.com" });
      clientRouter.get("/remote/items/:itemId");
    `,
  });
  assert.deepEqual(extractRoutes(dir), [],
    "a name suffix is not evidence that an HTTP client defines server routes");
});

test("an imported binding to an express.Router initializer is positive evidence", () => {
  const dir = service({
    "src/app.mjs": `
      import { itemsRouter } from "./items.mjs";
      itemsRouter.get("/secret/:itemId", handler);
      app.use("/api", itemsRouter);
    `,
    "src/items.mjs": `export const itemsRouter = express.Router();`,
  });
  assert.ok(has(extractRoutes(dir), "GET", "/api/secret/:itemId"));
});

test("a function configuring a module-scope router inherits lexical evidence", () => {
  const dir = service({
    "src/app.mjs": `
      import { itemsRouter } from "./items.mjs";
      app.use("/api", itemsRouter);
    `,
    "src/items.mjs": `
      export const itemsRouter = Router();
      export function registerItems() {
        itemsRouter.get("/secret/:itemId", handler);
      }
    `,
  });
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "GET", "/api/secret/:itemId"),
    `module-scope router evidence did not reach its configuring function: ${JSON.stringify(routes)}`);
  assert.ok(!has(routes, "GET", "/secret/:itemId"));
});

test("router evidence never crosses from a sibling function", () => {
  const dir = service({
    "src/items.mjs": `
      function createPrivateRouter() {
        const itemsRouter = Router();
        return itemsRouter;
      }
      function registerUnrelatedClient() {
        itemsRouter.get("/remote/items/:itemId");
      }
    `,
  });
  assert.deepEqual(extractRoutes(dir), [],
    "a same-named initializer in a sibling scope is not evidence for this receiver");
});

test("a local Axios binding shadows module-scope server-router evidence", () => {
  const dir = service({
    "src/app.mjs": `
      const clientRouter = Router();
      app.use("/api", clientRouter);
      function callRemote() {
        const clientRouter = axios.create({ baseURL: "https://api.example.com" });
        clientRouter.get("/remote/items/:itemId");
      }
    `,
  });
  assert.deepEqual(extractRoutes(dir), [],
    "the nearest lexical binding is a client, so the outer router is not evidence");
});

test("a local Axios binding also shadows an imported server router", () => {
  const dir = service({
    "src/app.mjs": `
      import { clientRouter } from "./server-router.mjs";
      app.use("/api", clientRouter);
      function callRemote() {
        const clientRouter = axios.create({ baseURL: "https://api.example.com" });
        clientRouter.get("/remote/items/:itemId");
      }
    `,
    "src/server-router.mjs": `export const clientRouter = Router();`,
  });
  assert.deepEqual(extractRoutes(dir), [],
    "a local declaration prevents falling through to an imported router binding");
});

test("N1-B registrar fixture composes the cross-module parameter and keeps its true shadow", async () => {
  const dir = join(new URL("./fixtures/audit-registrar/", import.meta.url).pathname);
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "POST", "/api/v0/child/photos/authorize"),
    `registrar route was not composed: ${JSON.stringify(routes)}`);
  const audited = await auditSurface({ dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 2 }, { execute: false });
  assert.deepEqual(audited.shadowRoutes.filter((r) => !r.infra).map((r) => `${r.method} ${r.path} — ${r.rule}`).sort(),
    ["GET /api/v0/child/undocumented — mount + local route"]);
  assert.match(routes.find((r) => r.method === "POST").rule, /mount \+ registrar\(param\) \+ local route/);
});

test("N1-B method-call fixture composes both bare-root verbs and keeps its true shadow", async () => {
  const dir = join(new URL("./fixtures/audit-method-call/", import.meta.url).pathname);
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "GET", "/api/v0/local-photo-objects"), `GET root lost its prefix: ${JSON.stringify(routes)}`);
  assert.ok(has(routes, "PUT", "/api/v0/local-photo-objects"), `PUT root lost its prefix: ${JSON.stringify(routes)}`);
  const audited = await auditSurface({ dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 3 }, { execute: false });
  assert.deepEqual(audited.shadowRoutes.filter((r) => !r.infra).map((r) => `${r.method} ${r.path} — ${r.rule}`).sort(),
    ["DELETE /api/v0/local-photo-objects/undocumented — mount + local route"]);
});

test("N1-B unknown require remains a named unresolved route", () => {
  const dir = service({ "src/app.mjs": `
    const externalRouter = require("unknown-package");
    externalRouter.get("/dynamic-secret", handler);
  ` });
  const route = extractRoutes(dir).find((r) => r.path === "/dynamic-secret");
  assert.equal(route?.reason, "unresolved router identity");
});

test("N1-B live multiline identity shapes compose their own mounts and preserve one shadow", async () => {
  const dir = join(new URL("./fixtures/audit-live-shapes/", import.meta.url).pathname);
  const routes = extractRoutes(dir);
  for (const [method, path] of [
    ["GET", "/api/v0/parent/profile"], ["POST", "/api/v0/parent/photos/authorize"],
    ["GET", "/api/v0/public"], ["GET", "/api/v0/child/profile"],
    ["POST", "/api/v0/child/photos/authorize"], ["POST", "/api/v0/child/planner/parse"],
    ["POST", "/api/v0/child/homework/check"], ["POST", "/api/v0/child/tutor/ask"],
  ]) assert.ok(has(routes, method, path), `${method} ${path} missing: ${JSON.stringify(routes)}`);
  assert.ok(!routes.some((r) => r.path === "/profile" || r.path === "/photos/authorize"));
  const audited = await auditSurface({ dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 7 }, { execute: false });
  assert.deepEqual(audited.shadowRoutes.filter((r) => !r.infra).map((r) => `${r.method} ${r.path} — ${r.rule}`),
    ["GET /api/v0/child/profile — mount(multi-line) + factory(positional, optional param) + local route"]);
  assert.match(routes.find((r) => r.path === "/api/v0/child/photos/authorize").rule,
    /mount\(multi-line\).*factory\(positional, optional param\).*if\(param\).*registrar\(param\)/);
});

test("N1-B typed method-call fixture composes a guarded default instance and keeps its shadow", async () => {
  const dir = join(new URL("./fixtures/audit-method-call-live/", import.meta.url).pathname);
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "PUT", "/api/v0/local-photo-objects/:token"));
  assert.ok(has(routes, "GET", "/api/v0/local-photo-objects/:token"));
  const audited = await auditSurface({ dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 2 }, { execute: false });
  assert.deepEqual(audited.shadowRoutes.filter((r) => !r.infra).map((r) => `${r.method} ${r.path} — ${r.rule}`),
    ["DELETE /api/v0/local-photo-objects/undocumented — mount(type-guarded) + instance(factory default) + method router + local route"]);
});

test("an imported arrow-function router factory resolves its mount", () => {
  const dir = service({
    "src/app.mjs": `
      import { createItemsRouter } from "./items.mjs";
      app.use("/api/v1", createItemsRouter());
    `,
    "src/items.mjs": `
      export const createItemsRouter = () => {
        const router = Router();
        router.get("/items/:itemId", handler);
        return router;
      };
    `,
  });
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "GET", "/api/v1/items/:itemId"));
  assert.ok(!has(routes, "GET", "/items/:itemId"));
});

test("an explicit import disambiguates same-named factories without a global guess", () => {
  const dir = service({
    "src/app.mjs": `
      import { createRouter as createItemsRouter } from "./items.mjs";
      app.use("/items-api", createItemsRouter());
    `,
    "src/ambiguous.mjs": `app.use("/ambiguous", createRouter()); app.use("/also-ambiguous", createStandalone());`,
    "src/items.mjs": `
      export function createRouter() {
        const router = Router();
        router.get("/items", handler);
        return router;
      }
    `,
    "src/jobs.mjs": `
      export function createRouter() {
        const router = Router();
        router.get("/jobs", handler);
        return router;
      }
    `,
    "src/standalone.mjs": `function createStandalone() { const router = Router(); router.get('/standalone', handler); return router; }`,
    "src/no-route-literals.mjs": `function createStandalone() { return null; }`,
  });
  const routes = extractRoutes(dir);
  assert.ok(has(routes, "GET", "/items-api/items"),
    `the explicit aliased import was not followed: ${JSON.stringify(routes)}`);
  assert.ok(has(routes, "GET", "/jobs"), "the same-named sibling remains local");
  assert.ok(!routes.some((r) => r.path.startsWith("/ambiguous/")),
    `an unresolved same-name mount guessed across files: ${JSON.stringify(routes)}`);
  assert.ok(!has(routes, "GET", "/items-api/jobs"),
    "the imported factory's prefix crossed onto its same-named sibling");
  assert.ok(has(routes, "GET", "/standalone"));
  assert.ok(!has(routes, "GET", "/also-ambiguous/standalone"),
    'A same-named factory without route literals still prevents a global unique-name guess.');
});

test('route filtering does not disambiguate competing extensionless import targets', t => {
  const dir = service({
    'src/app.mjs': 'import { router } from "./router";\napp.use("/api", router);\n',
    'src/router.ts': 'export const router = Router();\nrouter.get("/items", handler);\n',
    'src/router.js': 'export const router = null;\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const routes = withSourceScan(createSourceScan(dir), () => extractRoutes(dir));
  assert.deepEqual(routes.map(route => route.path), ['/items'],
    'A competing non-route module keeps an extensionless router import unresolved.');
});

test("the same route in two files is counted once and keeps both code locations", () => {
  const dir = service({
    "src/a.mjs": `app.get("/dup", h);`,
    "src/b.mjs": `app.get("/dup", h);`,
  });
  const routes = extractRoutes(dir).filter((r) => r.path === "/dup");
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].locations.map(({ file, line }) => ({ file, line })),
    [{ file: 'src/a.mjs', line: 1 }, { file: 'src/b.mjs', line: 1 }]);
});

test('route scope work stays within relevant files and preserves nested, closed and adjacent scopes', t => {
  const files = {
    'src/app.mjs': 'import { createRouter } from "./routes.mjs";\napp.use("/api", createRouter());\n',
    'src/routes.mjs': `export function createRouter() {
      const outerRouter = Router();
      function inner() {
        const innerRouter = Router();
        innerRouter.get('/inner', handler);
        return innerRouter;
      }
      outerRouter.use('/nested', inner());
      outerRouter.get('/after-inner', handler);
      function adjacent() {
        const siblingRouter = Router();
        siblingRouter.get('/sibling', handler);
        return siblingRouter;
      }
      outerRouter.use('/adjacent', adjacent());
      outerRouter.get('/after-adjacent', handler);
      return outerRouter;
    }
    function unused() { const unrelated = 1; }
    const rootRouter = Router();
    rootRouter.get('/root-after-functions', handler);
    `,
  };
  files['src/routes.mjs'] += Array.from({ length: 80 }, (_, n) =>
    `\nfunction unusedScope${n}(input) { const next = input + ${n}; return next; }`).join('');
  for (let file = 0; file < 80; file++) files[`src/util-${file}.mjs`] = Array.from({ length: 40 }, (_, n) =>
    `export function utility${n}(input) { const next = input + ${n}; return next; }`).join('\n');
  const dir = service(files);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scan = createSourceScan(dir);
  const routes = withSourceScan(scan, () => extractRoutes(dir));
  assert.deepEqual(routes.map(route => route.path).sort(), [
    '/api/adjacent/sibling', '/api/after-adjacent', '/api/after-inner', '/api/nested/inner', '/root-after-functions',
  ]);
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(scan.stats).filter(([name]) => name.startsWith('route_')))));
  assert.equal(scan.stats.route_source_files, 82);
  assert.equal(scan.stats.route_candidate_files, 2, 'Unrelated function files do not enter route scope analysis.');
  assert.equal(scan.stats.route_scopes_indexed, 84);
  assert.ok(scan.stats.route_scope_comparisons <= scan.stats.route_scope_lookups * 9,
    'Each lookup searches the small per-file scope index rather than all functions in the tree.');
});

// --- Windows path separators -------------------------------------------------
//
// Every exclusion guard in the audit is written with forward slashes. On Windows
// the same paths arrive with backslashes, so without normalising, TEST_FILE and
// FIXTURE_PATH silently stop matching and the tool reports test files and
// fixtures as real API routes. That is the cry-wolf failure, on a whole platform,
// and it fails silently — the tool still runs, it just starts lying.

test("the path guards match Windows separators too", async () => {
  const { toPosix } = await import("../lib/audit.mjs");
  const TEST_FILE = /(\.|\/|^)(test|spec)\.|\/(tests?|__tests__|spec|e2e)\//i;
  const FIXTURE = /\/(fixtures?|__fixtures__|testdata|test-data|samples?|examples?|e2e|__tests__|spec\/support)\//i;

  for (const [posix, win] of [
    ["src/tests/app.mjs", "src\\tests\\app.mjs"],
    ["src/__tests__/x.js", "src\\__tests__\\x.js"],
    ["a/e2e/spec.ts", "a\\e2e\\spec.ts"],
  ]) {
    assert.ok(TEST_FILE.test(toPosix(posix)), `posix not excluded: ${posix}`);
    assert.ok(TEST_FILE.test(toPosix(win)), `WINDOWS path not excluded: ${win}`);
  }
  for (const [posix, win] of [
    ["a/fixtures/b.json", "a\\fixtures\\b.json"],
    ["p/examples/openapi.yaml", "p\\examples\\openapi.yaml"],
  ]) {
    assert.ok(FIXTURE.test(toPosix(posix)), `posix fixture not excluded: ${posix}`);
    assert.ok(FIXTURE.test(toPosix(win)), `WINDOWS fixture not excluded: ${win}`);
  }
});
