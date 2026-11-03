import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mapSourceFiles, sourceFileFor } from "../lib/context.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "source-mapping-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

test("demo-style dispatch source wins over repeated test and contract paths", () => {
  const root = fixture({
    "src/server.mjs": `function dispatch(method, path) {
      const [resource, id, action] = path.split('/').filter(Boolean);
      if (resource === 'rollouts' && method === 'POST' && action === 'activate') return activate(id);
    }`,
    "src/openapi.mjs": `route('post', '/rollouts/{id}/activate', 'activate');\n`.repeat(30),
    "test/server.test.mjs": `await post('/rollouts/one/activate');\n`.repeat(50),
    "evidence/fixture.mjs": `const path = '/rollouts/{id}/activate';`,
    "src/generated/contract.mjs": `const path = '/rollouts/{id}/activate';`,
  });
  const index = mapSourceFiles(root);
  assert.deepEqual([...index.keys()], ["src/server.mjs"]);
  assert.equal(sourceFileFor("/rollouts/{id}/activate", index), "src/server.mjs");
});

test("operation with only test or contract-generator references stays unmapped", () => {
  const index = new Map([
    ["test/server.test.mjs", `post('/widgets')`],
    ["src\\__tests__\\server.mjs", `post('/widgets')`],
    ["src/openapi.mjs", `route('post', '/widgets')`],
    ["src/swagger.ts", `path('/widgets')`],
  ]);
  assert.equal(sourceFileFor("/widgets", index), null);
});

test("named OpenAPI and Swagger generators never turn a path table into implementation hints", (t) => {
  const names = ["scripts/gen_openapi.py", "tools/generate-openapi.ts", "tools/build_openapi.mjs",
    "scripts/export-swagger.rb", "tools/generate_swagger.js", "tools/GEN_SWAGGER.py",
    "tools/openapi_generator.py", "tools/swagger_gen.go", "tools/openapi_export.py"];
  const paths = ["/widgets", "/widgets/{id}", "/widgets/{id}/activate"];
  const table = `paths = [${paths.map((path) => JSON.stringify(path)).join(", ")}]`;
  const files = Object.fromEntries(names.map((name) => [name, table]));
  const root = fixture({ ...files, "api.yaml": "openapi: 3.0.0\npaths:\n  /widgets: {}\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual([...mapSourceFiles(root)], [], "declaration generators are not implementation source");
  for (const path of paths) {
    assert.equal(sourceFileFor(path, new Map(Object.entries(files))), null);
    assert.equal(sourceFileFor(path, new Map([["scripts\\gen_openapi.py", table]])), null);
  }
});

test("runtime handlers under scripts remain eligible beside an OpenAPI generator", (t) => {
  const root = fixture({
    "scripts/gen_openapi.py": `paths = {"/widgets/{id}/activate": {"post": {}}}`,
    "scripts/api_handlers.py": `@app.post('/widgets/{id}/activate')\ndef activate(id): pass`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const index = mapSourceFiles(root);
  assert.deepEqual([...index.keys()], ["scripts/api_handlers.py"]);
  assert.equal(sourceFileFor("/widgets/{id}/activate", index), "scripts/api_handlers.py");
});

test("generator exclusion is an explicit basename convention, not a substring or directory heuristic", (t) => {
  const names = ["scripts/gen_openapi_handler.py", "scripts/generate_reports.py", "scripts/openapi_routes.py",
    "scripts/my_gen_openapi.py", "scripts/swagger_handler.py"];
  const root = fixture(Object.fromEntries(names.map((name, i) => [name, `app.get('/route-${i}', handler)`])));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const index = mapSourceFiles(root);
  assert.equal(index.size, names.length);
  for (const [i, name] of names.entries()) assert.equal(sourceFileFor(`/route-${i}`, index), name);
});

test("a specific nested route beats repeated collection mentions elsewhere", () => {
  const index = new Map([
    ["src/collection.mjs", `const collection = '/widgets';\n`.repeat(100)],
    ["src/actions.mjs", `app.post('/widgets/:id/activate', activate);`],
  ]);
  assert.equal(sourceFileFor("/widgets/{id}/activate", index), "src/actions.mjs");
});

test("ambiguous source hints remain unmapped independent of file order", () => {
  const entries = [["src/a.mjs", `app.get('/widgets', a);`], ["src/b.mjs", `app.get('/widgets', b);`]];
  assert.equal(sourceFileFor("/widgets", new Map(entries)), null);
  assert.equal(sourceFileFor("/widgets", new Map(entries.reverse())), null);
});
