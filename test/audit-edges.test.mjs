import { LAYOUT } from "../lib/layout.mjs";
// Edges are the map (ADR-0034): who calls whom, derived from source not declared.
//
//   node --test test/audit-edges.test.mjs
//
// The signal is a consumer naming an upstream's base URL, matched against the
// base URL every surface already advertises. Match host:port, edge falls out.
// The failure to guard against is the same as everywhere else: inventing an edge
// that is not there (a documentation URL, a service's reference to itself).

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEdges } from "../lib/audit.mjs";
import { mkdtempSync, mkdirSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Build a set of surfaces with source, each advertising a base URL via
// api-environments.json — exactly what deriveEdges reads.
function surfaces(specs) {
  const root = mkdtempSync(join(tmpdir(), "edges-test-"));
  const out = [];
  for (const [name, { port, src = {} }] of Object.entries(specs)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
      default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${port}` } },
    }));
    for (const [f, content] of Object.entries(src)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), content);
    }
    out.push({ name, dir });
  }
  return out;
}
const edge = (edges, from, to) => edges.some((e) => e.from === from && e.to === to);

test("a consumer naming an upstream's base URL yields an edge", () => {
  const s = surfaces({
    identity: { port: 9101 },
    gateway: { port: 9104, src: {
      "src/config.mjs": `export const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://127.0.0.1:9101";`,
    } },
  });
  const { edges } = deriveEdges(s);
  assert.ok(edge(edges, "gateway", "identity"));
  assert.equal(edges.length, 1);
});

test("a service referencing its OWN base URL is not an edge to itself", () => {
  const s = surfaces({
    identity: { port: 9101, src: {
      "src/config.mjs": `const SELF = "http://127.0.0.1:9101"; const log = "http://127.0.0.1:9101/health";`,
    } },
  });
  assert.deepEqual(deriveEdges(s).edges, []);
});

test("fan-out: one consumer, several upstreams", () => {
  const s = surfaces({
    identity: { port: 9101 }, catalog: { port: 9102 }, orders: { port: 9103 },
    gateway: { port: 9104, src: { "src/config.mjs": `
      export const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://127.0.0.1:9101";
      export const CATALOG_URL  = process.env.CATALOG_URL  ?? "http://127.0.0.1:9102";
      export const ORDERS_URL   = process.env.ORDERS_URL   ?? "http://127.0.0.1:9103";
    ` } },
  });
  const { edges } = deriveEdges(s);
  assert.ok(edge(edges, "gateway", "identity"));
  assert.ok(edge(edges, "gateway", "catalog"));
  assert.ok(edge(edges, "gateway", "orders"));
  assert.equal(edges.length, 3);
});

test("a URL matching no surface is an external upstream, not an invented edge", () => {
  const s = surfaces({
    catalog: { port: 9102, src: {
      "src/pay.mjs": `const STRIPE = "https://api.stripe.com/v1/charges";`,
    } },
  });
  const { edges, external } = deriveEdges(s);
  assert.deepEqual(edges, [], "a third-party host is not one of our surfaces");
  assert.ok(external.some((e) => e.from === "catalog" && /stripe/.test(e.url)));
});

test("a URL in a TEST file does not create an edge", () => {
  const s = surfaces({
    identity: { port: 9101 },
    gateway: { port: 9104, src: {
      "src/app.test.mjs": `fetch("http://127.0.0.1:9101/whoami");`,
    } },
  });
  assert.deepEqual(deriveEdges(s).edges, [], "a test's call is not an architectural dependency");
});

test("incoming request parser fallback bases are not external dependencies", () => {
  const s = surfaces({
    rollouts: { port: 9412, src: { "src/server.mjs": `
      const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:9411';
      const url = new URL(req.url, 'http://localhost');
      const original = new URL(request.originalUrl, 'http://registry.local');
      const outbound = new URL('/devices', 'https://api.vendor.com');
      await fetch(new URL(req.url, 'https://proxy.vendor.com'));
      const upstream = new URL(req.url, 'https://assigned-proxy.vendor.com');
      await fetch(upstream);
    ` } },
  });
  const { edges, external } = deriveEdges(s);
  assert.deepEqual(edges, [], "a service outside the scanned surfaces stays external");
  assert.deepEqual(external.map((e) => new URL(e.url).host).sort(),
    ["127.0.0.1:9411", "api.vendor.com", "assigned-proxy.vendor.com", "proxy.vendor.com"]);
});

test("including the provider surface turns the same dependency into a service edge", () => {
  const s = surfaces({
    registry: { port: 9411 },
    rollouts: { port: 9412, src: { "src/server.mjs": `
      const registryUrl = (options.registryUrl ?? process.env.REGISTRY_URL ?? 'http://127.0.0.1:9411').replace(/\\/$/, '');
      const url = new URL(req.url, 'http://localhost');
    ` } },
  });
  const result = deriveEdges(s);
  assert.deepEqual(result.edges, [{ from: "rollouts", to: "registry", via: "src/server.mjs" }]);
  assert.deepEqual(result.external, []);
});

// --- a URL is not a dependency until something calls or binds it -------------
//
// The day-one demo surface reported a content site as "calling" 988lifeline.org,
// rainn.org and 22 other hosts, because those hyperlinks live in guide data.
// 99 of 103 external claims across the real tree were that shape. An auditor
// whose first screen is mostly wrong gets closed.

test("content hyperlinks in a data file are NOT external dependencies", () => {
  const s = surfaces({
    site: { port: 9990, src: { "src/data/guides.js": `
export const guides = [
  { label: 'Crisis line', href: 'https://988lifeline.org/help' },
  { label: 'CDC', href: 'https://www.cdc.gov/vaccines' },
];` } },
  });
  assert.deepEqual(deriveEdges(s).external, [],
    "a hyperlink in content is a mention, not a call");
});

test("a bare assignment of a URL IS a dependency, whatever the name", () => {
  const s = surfaces({
    pay: { port: 9991, src: { "src/pay.mjs": `const STRIPE = "https://api.stripe.com/v1/charges";` } },
  });
  assert.ok(deriveEdges(s).external.some((e) => /stripe/.test(e.url)),
    "an assignment binds an endpoint even when the name is not url-ish");
});

test("an env-defaulted config assignment is a dependency", () => {
  // The corpus shape: the assignment and the URL share a line, via ?? default.
  const s = surfaces({
    gw: { port: 9992, src: { "src/config.mjs":
      `export const CATALOG_URL = process.env.CATALOG_URL ?? "https://catalog.example.com";` } },
  });
  assert.ok(deriveEdges(s).external.some((e) => /catalog\.example\.com/.test(e.url)));
});

test("prose containing the word 'request' does not create a dependency", () => {
  // "Requests to resign membership', href: 'https://…'" matched a naive
  // call-token pattern and invented an outbound call from a paragraph of text.
  const s = surfaces({
    site: { port: 9993, src: { "src/data/life.js": `
  { label: '2.14.9 Requests to resign membership', href: 'https://www.example-church.org/manual' },` } },
  });
  assert.deepEqual(deriveEdges(s).external, []);
});

test("a committed design-prototype bundle is not a runtime dependency", () => {
  const s = surfaces({
    site: { port: 9994, src: {
      "sample-app-design-v1/support.js": `
        // Generated support code committed with a design prototype.
        var REACT_URL = "https://unpkg.com/react@18.3.1/umd/react.production.min.js";
        var BABEL_URL = "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js";
      `,
      "src/pay.mjs": `const STRIPE = "https://api.stripe.com/v1/charges";`,
    } },
  });
  const external = deriveEdges(s).external;
  assert.ok(!external.some((e) => /unpkg\.com/.test(e.url)),
    `design-prototype text was reported as a runtime dependency: ${JSON.stringify(external)}`);
  assert.ok(external.some((e) => /api\.stripe\.com/.test(e.url)),
    "excluding prototype artifacts must not hide real runtime dependencies");
});
