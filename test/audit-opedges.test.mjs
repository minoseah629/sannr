import { LAYOUT } from "../lib/layout.mjs";
// Operation-level edges: not just WHO a consumer calls, but WHICH declared
// operations of the upstream its source actually sends requests to.
//
//   node --test test/audit-opedges.test.mjs
//
// The two failure modes guarded here mirror the whole tool's ethic:
//   - inventing an operation (attributing a free-floating path, or claiming an
//     op the upstream never declared) is worse than missing one;
//   - a call the upstream's contract does NOT declare is still reported, as an
//     unmatched call — an undocumented dependency, not silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEdges, upstreamCalls } from "../lib/audit.mjs";
import { mkdtempSync, mkdirSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// A contract the upstream declares; enough shape for operationsFrom.
const CATALOG_SPEC = `openapi: 3.0.0
info:
  title: catalog
  version: "1"
paths:
  /events:
    get:
      summary: list
    post:
      summary: create
  /events/{id}:
    get:
      summary: one
  /events/{id}/availability:
    get:
      summary: seats
  /health:
    get:
      summary: alive
`;

function surfaces(specs) {
  const root = mkdtempSync(join(tmpdir(), "opedges-test-"));
  const out = [];
  for (const [name, { port, contract, src = {} }] of Object.entries(specs)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
      default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${port}` } },
    }));
    const s = { name, dir };
    if (contract) {
      writeFileSync(join(dir, "openapi.yaml"), contract);
      s.contract = join(dir, "openapi.yaml");
    }
    for (const [f, content] of Object.entries(src)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), content);
    }
    out.push(s);
  }
  return out;
}
const between = (edges, from, to) => edges.find((e) => e.from === from && e.to === to);

test("a path in a template next to the upstream's URL binding becomes a declared op", () => {
  const s = surfaces({
    catalog: { port: 9102, contract: CATALOG_SPEC },
    orders: { port: 9103, src: { "src/server.mjs": `
      const CATALOG_URL = process.env.CATALOG_URL ?? "http://127.0.0.1:9102";
      const catalogEvent = (eventId) => getJson(\`\${CATALOG_URL}/events/\${eventId}\`);
      const catalogSeats = (eventId) => getJson(\`\${CATALOG_URL}/events/\${eventId}/availability\`);
    ` } },
  });
  const e = between(deriveEdges(s).edges, "orders", "catalog");
  assert.ok(e, "the service edge itself");
  assert.deepEqual(e.operations, ["GET /events/{id}", "GET /events/{id}/availability"],
    "the declared spelling, derived from call sites");
});

test("helper aliases resolve through BASES-style indirection, with methods", () => {
  const s = surfaces({
    catalog: { port: 9102, contract: CATALOG_SPEC },
    gateway: { port: 9104, src: {
      "src/config.mjs": `export const CATALOG_URL = process.env.CATALOG_URL ?? "http://127.0.0.1:9102";`,
      "src/upstream.mjs": `
        import { CATALOG_URL } from "./config.mjs";
        export const BASES = { catalog: CATALOG_URL };
        export async function call(service, path, init) { return fetch(\`\${BASES[service]}\${path}\`, init); }
        export const catalog = (path, init) => call("catalog", path, init);
      `,
      "src/server.mjs": `
        import { catalog } from "./upstream.mjs";
        app.get("/v1/home", async (c) => {
          const health = await catalog("/health");
          const res = await catalog(\`/events?\${query}\`);
          return c.json(res);
        });
        app.post("/v1/events", async (c) => {
          const res = await catalog("/events", { method: "POST", body: await c.req.json() });
          return c.json(res);
        });
      `,
    } },
  });
  const e = between(deriveEdges(s).edges, "gateway", "catalog");
  assert.ok(e);
  assert.deepEqual(e.operations, ["GET /events", "GET /health", "POST /events"],
    "query strings stripped, method read from the call options");
});

test("a free-floating path literal is never attributed to an upstream", () => {
  const s = surfaces({
    catalog: { port: 9102, contract: CATALOG_SPEC },
    orders: { port: 9103, src: { "src/server.mjs": `
      const CATALOG_URL = process.env.CATALOG_URL ?? "http://127.0.0.1:9102";
      // This service defines its OWN /events route and never calls catalog's.
      app.get("/events", (c) => c.json([]));
      const nothing = "/health";
    ` } },
  });
  const e = between(deriveEdges(s).edges, "orders", "catalog");
  assert.ok(e, "the URL reference alone still yields the service edge");
  assert.equal(e.operations, undefined,
    "no path sits next to the binding, so no operation may be claimed");
});

test("a call the upstream never declared is an unmatched call, not an invented op", () => {
  const s = surfaces({
    catalog: { port: 9102, contract: CATALOG_SPEC },
    orders: { port: 9103, src: { "src/server.mjs": `
      const CATALOG_URL = process.env.CATALOG_URL ?? "http://127.0.0.1:9102";
      const tags = () => getJson(\`\${CATALOG_URL}/tags\`);
      const one = (id) => getJson(\`\${CATALOG_URL}/events/\${id}\`);
    ` } },
  });
  const e = between(deriveEdges(s).edges, "orders", "catalog");
  assert.deepEqual(e.operations, ["GET /events/{id}"]);
  assert.deepEqual(e.unmatchedCalls, ["GET /tags"],
    "reported as unmatched — never promoted into the declared set");
});

test("upstream calls in TEST files are ignored, like the edges themselves", () => {
  const s = surfaces({
    catalog: { port: 9102, contract: CATALOG_SPEC },
    orders: { port: 9103, src: {
      "src/server.mjs": `const CATALOG_URL = "http://127.0.0.1:9102";`,
      "src/server.test.mjs": `
        const CATALOG_URL = "http://127.0.0.1:9102";
        const seed = () => fetch(\`\${CATALOG_URL}/events\`, { method: "POST" });
      `,
    } },
  });
  const e = between(deriveEdges(s).edges, "orders", "catalog");
  assert.equal(e.operations, undefined, "a test's call is not an architectural dependency");
});

test("semicolon-less source: a later statement's method literal never bleeds into a call", () => {
  // standard.js style has no `;` to cut the option window at. Before the fix,
  // the window ran to the first semicolon in the FILE, so `const opts =
  // { method: "PUT" }` on the next line turned a plain GET into a PUT — which
  // can invent a declared operation the consumer never sends.
  const root = mkdtempSync(join(tmpdir(), "opedges-nosemi-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "nosemi.mjs"), [
    'const UPS = "http://127.0.0.1:9666"',
    'const r = await fetch(`${UPS}/widgets`)',
    'const opts = { method: "PUT" }',
    "export { r, opts }",
  ].join("\n"));
  const calls = upstreamCalls(root, new Map([["127.0.0.1:9666", true]]));
  const got = (calls.get("127.0.0.1:9666") ?? []).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(got, ["GET /widgets"],
    "the PUT belongs to a different statement; claiming it invents an operation");
});

test("semicolon-less source: options in the SAME call are still read", () => {
  const root = mkdtempSync(join(tmpdir(), "opedges-nosemi2-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "client.mjs"), [
    'const UPS = "http://127.0.0.1:9666"',
    'await fetch(`${UPS}/widgets`, { method: "POST" })',
    'await client.request({ url: `${UPS}/gadgets`, method: "DELETE" })',
  ].join("\n"));
  const calls = upstreamCalls(root, new Map([["127.0.0.1:9666", true]]));
  const got = (calls.get("127.0.0.1:9666") ?? []).map((c) => `${c.method} ${c.path}`).sort();
  assert.deepEqual(got, ["DELETE /gadgets", "POST /widgets"],
    "a sibling option key and a second-argument object both belong to the call");
  assert.ok(calls.get("127.0.0.1:9666").every(row => row.locations.every(location => location.kind === 'request')),
    'Both the direct request and its object-envelope form carry actual call locations.');
});

test("upstreamCalls: concat and new URL() forms, and the method from a .post() attribute", () => {
  const root = mkdtempSync(join(tmpdir(), "opedges-calls-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "client.py"), `
CATALOG_URL = os.environ.get("CATALOG_URL", "http://127.0.0.1:9102")
def create(payload):
    return requests.post(f"{CATALOG_URL}/events", json=payload)
`);
  writeFileSync(join(root, "src", "client.mjs"), `
    const CATALOG_URL = process.env.CATALOG_URL ?? "http://127.0.0.1:9102";
    const a = fetch(CATALOG_URL + "/health");
    const b = fetch(new URL("/events", CATALOG_URL));
  `);
  const calls = upstreamCalls(root, new Map([["127.0.0.1:9102", true]]));
  const got = (calls.get("127.0.0.1:9102") ?? []).map((c) => `${c.method} ${c.path}`).sort();
  assert.deepEqual(got, ["GET /events", "GET /health", "POST /events"]);
  assert.ok(calls.get("127.0.0.1:9102").every(row => row.locations.every(location => location.kind === 'request')),
    'The f-string, concatenation and nested URL occur inside recognizable request expressions.');
});

test("an outbound call uses its own file's URL binding instead of a same-named binding in another file", () => {
  const root = mkdtempSync(join(tmpdir(), 'opedges-binding-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.mjs'), 'const BASE_URL = "https://alpha.example.test/v1";\nfetch(`${BASE_URL}/alpha`);\n');
  writeFileSync(join(root, 'src/b.mjs'), 'const BASE_URL = "https://beta.example.test/v2";\nfetch(`${BASE_URL}/beta`);\n');
  writeFileSync(join(root, 'src/c.mjs'), 'fetch(`${BASE_URL}/unbound`);\n');
  writeFileSync(join(root, 'src/d.mjs'), 'const BASE_URL = "https://alpha.example.test/v1";\nconst address = (path) => BASE_URL + path;\nconst preview = address("/invoices");\n');
  writeFileSync(join(root, 'src/e.mjs'), 'const BASE_URL = "https://beta.example.test/v2";\nfunction load(BASE_URL) { return fetch(`${BASE_URL}/invoices`); }\n');
  writeFileSync(join(root, 'src/comments.mjs'), [
    'const BASE_URL = "https://alpha.example.test/v1";',
    '// fetch(`${BASE_URL}/invoices`);',
    '// fetch("https://alpha.example.test/v1/invoices");',
    '/* fetch("https://alpha.example.test/v1/invoices"); */',
  ].join('\n'));
  const calls = upstreamCalls(root, new Map([['alpha.example.test:443', true], ['beta.example.test:443', true]]));
  assert.deepEqual(Object.fromEntries([...calls].map(([host, rows]) => [host, rows.flatMap(row => row.locations.map(location => [row.path, location.file]))])), {
    'alpha.example.test:443': [['/alpha', 'src/a.mjs']],
    'beta.example.test:443': [['/beta', 'src/b.mjs']],
  }, 'Pure URL helpers, commented requests and shadowed parameters cannot become calls to a module-level provider.');
});

test('an explicit HEAD or OPTIONS stays distinct from GET, and an unknown method is not guessed', () => {
  const root = mkdtempSync(join(tmpdir(), 'opedges-method-'));
  writeFileSync(join(root, 'client.mjs'), [
    'const BASE_URL = "https://alpha.example.test/v1";',
    'fetch(`${BASE_URL}/head`, { method: "HEAD" });',
    'fetch(`${BASE_URL}/options`, { method: "OPTIONS" });',
    'fetch(`${BASE_URL}/dynamic`, { method: selectedMethod });',
    'fetch(`${BASE_URL}/unknown`, { method: "SOMETHING" });',
  ].join('\n'));
  const calls = upstreamCalls(root, new Map([['alpha.example.test:443', true]]));
  assert.deepEqual(calls.get('alpha.example.test:443').map(row => [row.method, row.path]), [
    ['HEAD', '/head'], ['OPTIONS', '/options'],
  ]);
});
