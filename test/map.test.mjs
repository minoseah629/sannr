import { LAYOUT } from "../lib/layout.mjs";
// The map (Track A1): the derived graph rendered as a shareable artifact.
//
//   node --test test/map.test.mjs
//
// `sannr map` renders what the audit already DERIVES — edges, shadow
// routes, ownership, drift — into three forms: a self-contained HTML file a
// human opens standalone, --json for machines, --text for a terminal. The
// invariants pinned here are the ones that make the artifact trustworthy:
// the graph is exactly deriveEdges' graph (never re-derived by the renderer),
// shadow routes keep the severity the audit graded them, the HTML performs
// ZERO external requests and carries ZERO script, everything interpolated is
// escaped, and a tree with no APIs is a named error rather than a crash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync,  readFileSync, existsSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { footprintModel, renderMapText, renderMapHtml } from "../lib/map.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

function run(args, opts = {}) {
  try {
    return { code: 0, out: execFileSync("node", [CLI, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }) };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }; }
}

// An audited-result-shaped service, as auditSurface returns it.
const svc = (name, over = {}) => ({
  name, dir: `/repo/${name}`, kind: "documented", declared: 5,
  repo: name, owner: "ana", ownerSource: "git, active last 12mo",
  reachable: true, checked: 0, findings: [], shadowRoutes: [], shadowCount: 0, ...over,
});

const model = () => footprintModel({
  root: "/repo",
  surfaces: [
    svc("gateway", { declared: 9 }),
    svc("identity", {
      shadowRoutes: [
        { method: "GET", path: "/internal/metrics", file: "src/a.mjs", infra: false },
        { method: "GET", path: "/health", file: "src/a.mjs", infra: true },
      ],
      findings: [{ op: "GET /whoami", kind: "schema-mismatch", detail: "email documented, absent" }],
    }),
  ],
  edges: [{ from: "gateway", to: "identity", via: "src/config.mjs", operations: ["GET /whoami"] }],
  external: [
    { from: "gateway", url: "https://api.stripe.com:443", via: "a.mjs" },
    { from: "gateway", url: "https://api.stripe.com:443", via: "b.mjs" },
  ],
  platform: [],
});

// --- the model -------------------------------------------------------------

test("footprintModel counts what the audit derived and grades severity on the way", () => {
  const m = model();
  assert.equal(m.summary.services, 2);
  assert.equal(m.summary.edges, 1);
  assert.equal(m.summary.shadow, 1, "an infra route (health/metrics-by-convention) is never a shadow finding");
  const id = m.services.find((s) => s.name === "identity");
  assert.equal(id.shadow.length, 1);
  assert.equal(id.shadow[0].severity, "high", "/internal is exactly the route the map exists to flag");
  assert.equal(id.findings[0].severity, "high", "schema-mismatch is high, same grading as the audit");
  assert.ok(m.summary.high >= 2);
});

test("external upstreams are deduped by host, callers preserved", () => {
  const m = model();
  assert.equal(m.external.length, 1, "the same host from two files is one upstream");
  assert.deepEqual(m.external[0].callers, ["gateway"]);
  assert.deepEqual(m.external[0].references, [
    { from: "gateway", file: "a.mjs" }, { from: "gateway", file: "b.mjs" },
  ], "the files behind an external relationship remain inspectable");
});

test("external dependencies explain scan scope and retain file evidence in each view", () => {
  const m = footprintModel({
    root: "/repo/rollouts", surfaces: [svc("rollouts")], edges: [], platform: [],
    external: [{ from: "rollouts", url: "http://127.0.0.1:9411", via: "src/server.mjs" }],
  });
  assert.equal(m.summary.edges, 0);
  assert.equal(m.summary.external, 1);
  for (const complete of [false, true]) {
    const text = renderMapText(m, { complete });
    assert.match(text, /outside scanned services/);
    assert.match(text, /127\.0\.0\.1:9411 ← rollouts \(src\/server\.mjs\)/);
  }
  const html = renderMapHtml(m);
  assert.match(html, /do not match a service in this scan/);
  assert.match(html, /rollouts: src\/server\.mjs/);
});

test("two checkouts advertising the same base URL are one service on the map", () => {
  // Found on the first real tree: ~/personal holds the corpus twice (standalone
  // repos AND a monorepo copy), and every service, edge and shadow route
  // rendered twice. The map's node identity must be the identity deriveEdges
  // already matches on — the advertised host:port — because two checkouts
  // claiming one live port are one service, not two.
  const root = mkdtempSync(join(tmpdir(), "map-merge-"));
  const envs = JSON.stringify({ default: "local",
    environments: { local: { baseUrl: "http://127.0.0.1:9902" } } });
  for (const d of ["a/catalog", "b/catalog"]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, LAYOUT.environments), envs);
  }
  const copy = (dir, repo) => svc("catalog", {
    dir: join(root, dir), repo, declared: 21,
    shadowRoutes: [{ method: "GET", path: "/tags", file: "src/server.mjs", infra: false }],
    findings: [{ op: "GET /collections", kind: "missing", detail: "documented but the server returns 404" }],
  });
  const m = footprintModel({
    root,
    surfaces: [copy("a/catalog", "catalog"), copy("b/catalog", "monorepo")],
    edges: [
      { from: "gateway", to: "catalog", via: "src/config.mjs", operations: ["GET /events"] },
      { from: "gateway", to: "catalog", via: "src/config.mjs", operations: ["GET /events"] },
    ],
    external: [], platform: [],
  });
  assert.equal(m.summary.services, 1, "one live service, however many checkouts");
  const cat = m.services[0];
  assert.deepEqual([...cat.repos].sort(), ["catalog", "monorepo"], "both checkouts stay named");
  assert.equal(cat.shadow.length, 1, "the same shadow route is not reported per checkout");
  assert.equal(cat.findings.length, 1, "the same live-server finding is not reported per checkout");
  assert.equal(m.summary.operations, 21, "operations are not double-counted");
  assert.equal(m.edges.length, 1, "the identical relationship from two checkouts is one edge");
});

// --- text mode -------------------------------------------------------------

test("text mode is a terse footprint: edges, shadow routes, severities", () => {
  const t = renderMapText(model());
  assert.match(t, /gateway/);
  assert.match(t, /→\s*identity/, "the edge shows as who-calls-whom");
  assert.match(t, /high\s+identity\s+GET \/internal\/metrics/, "shadow routes carry their severity");
  assert.match(t, /shadow/i);
});

// --- html mode -------------------------------------------------------------

test("the HTML artifact is standalone: no script, no external fetch of any kind", () => {
  const h = renderMapHtml(model());
  assert.match(h, /^<!doctype html>/i);
  assert.ok(!/<script[\s>]/i.test(h), "zero JS — nothing to audit, nothing to block");
  assert.ok(!/(?:src|href)\s*=\s*["']?https?:/i.test(h), "no external src/href");
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(h), "no CSS-driven fetches");
  assert.match(h, /prefers-color-scheme/, "theme-agnostic: renders in light and dark");
  assert.match(h, /<svg/, "the graph is drawn, not described");
});

test("the HTML carries the derived graph and the findings that matter", () => {
  const h = renderMapHtml(model());
  for (const name of ["gateway", "identity"]) assert.ok(h.includes(name));
  assert.ok(h.includes("GET /internal/metrics"), "the shadow route is in the artifact");
  assert.ok(h.includes("email documented, absent"), "the disagreement is in the artifact");
  assert.ok(h.includes("api.stripe.com"), "external upstreams are distinguished, not dropped");
  assert.ok(h.includes("ana"), "ownership travels with the service");
});

test("static HTML describes route definitions without claiming they answered traffic", () => {
  const m = model();
  for (const service of m.services) {
    service.reachable = null;
    service.findings = [];
  }
  m.services[0].kind = "undocumented";
  m.services[0].uncontracted = [{ method: "GET", path: "/items", file: "src/server.mjs" }];
  const h = renderMapHtml(m);
  assert.match(h, /route definitions but no OpenAPI document/);
  assert.match(h, /defined in source but absent from the service's OpenAPI document/);
  assert.match(h, /GET \/items/);
  assert.match(h, /GET \/internal\/metrics/);
  assert.match(h, /not probed/);
  assert.doesNotMatch(h, /live probes|answer traffic|running code|already live|Live routes/);
});

test("everything interpolated into the HTML is escaped", () => {
  const m = footprintModel({
    root: "/r",
    surfaces: [svc("<script>alert(1)</script>", {
      shadowRoutes: [{ method: "GET", path: "/a<b>", file: "x.mjs", infra: false }],
    })],
    edges: [], external: [], platform: [],
  });
  const h = renderMapHtml(m);
  assert.ok(!h.includes("<script>alert"), "a hostile service name must not become markup");
  assert.ok(h.includes("&lt;script&gt;"), "…it is escaped, not silently dropped");
});

// --- the CLI, end to end (offline: --no-execute) ---------------------------

// Two documented services wired the way real ones are: each advertises its
// base URL via api-environments.json, the consumer names the upstream's URL in
// source, and the upstream's code defines one route its spec never declares.
function corpusLike() {
  const root = mkdtempSync(join(tmpdir(), "map-test-"));
  const spec = (title, paths) => JSON.stringify({
    openapi: "3.0.0", info: { title }, paths,
  });
  const envs = (port) => JSON.stringify({
    default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${port}` } },
  });
  const identity = join(root, "identity");
  mkdirSync(join(identity, "src"), { recursive: true });
  writeFileSync(join(identity, "openapi.json"),
    spec("identity", { "/whoami": { get: { responses: { 200: { description: "ok" } } } } }));
  writeFileSync(join(identity, LAYOUT.environments), envs(9871));
  writeFileSync(join(identity, "src", "server.mjs"),
    `app.get("/whoami", h);\napp.get("/internal/metrics", h);\n`);

  const gateway = join(root, "gateway");
  mkdirSync(join(gateway, "src"), { recursive: true });
  writeFileSync(join(gateway, "openapi.json"),
    spec("gateway", { "/go": { get: { responses: { 200: { description: "ok" } } } } }));
  writeFileSync(join(gateway, LAYOUT.environments), envs(9872));
  writeFileSync(join(gateway, "src", "config.mjs"),
    `export const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://127.0.0.1:9871";\n`);
  writeFileSync(join(gateway, "src", "server.mjs"), `app.get("/go", h);\n`);
  return root;
}

test("map --json reports exactly the edges deriveEdges derives, offline", () => {
  const root = corpusLike();
  const { code, out } = run(["map", root, "--json", "--no-execute"]);
  assert.equal(code, 0, out);
  const m = JSON.parse(out);
  assert.equal(m.summary.services, 2);
  assert.ok(m.edges.some((e) => e.from === "gateway" && e.to === "identity"),
    "the consumer naming the upstream's base URL is the edge");
  const id = m.services.find((s) => s.name === "identity");
  assert.deepEqual(id.shadow.map((s) => `${s.method} ${s.path}`), ["GET /internal/metrics"]);
  assert.equal(id.shadow[0].severity, "high");
});

test("map writes a standalone HTML artifact where told to", () => {
  const root = corpusLike();
  const out = join(mkdtempSync(join(tmpdir(), "map-out-")), "footprint.html");
  const r = run(["map", root, "--no-execute", "--out", out, "--allow-outside-project"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(out), "the artifact exists at the named path");
  assert.match(r.out, /footprint\.html/, "the CLI says where it wrote");
  const h = readFileSync(out, "utf8");
  assert.match(h, /^<!doctype html>/i);
  assert.ok(!/<script[\s>]/i.test(h));
  assert.ok(h.includes("gateway") && h.includes("GET /internal/metrics"));
  assert.match(h, /not probed/);
  assert.doesNotMatch(h, /live probes|answer traffic|running code|Live routes/);
});

test("two DIFFERENT services sharing a basename are told apart, never conflated", () => {
  // The other half of the identity rule: ~/personal also holds the corpus as a
  // monorepo whose services advertise DIFFERENT ports. Same basename, different
  // host:port is two services, and a map that labels both "catalog" draws
  // edges nobody can attribute. The advertised port is the disambiguator
  // because it is the identity the edges were derived from.
  const root = mkdtempSync(join(tmpdir(), "map-twin-"));
  const mk = (dir, port) => {
    mkdirSync(join(root, dir, "src"), { recursive: true });
    writeFileSync(join(root, dir, "openapi.json"), JSON.stringify({
      openapi: "3.0.0", info: { title: "svc" },
      paths: { "/a": { get: { responses: { 200: { description: "ok" } } } } },
    }));
    writeFileSync(join(root, dir, LAYOUT.environments), JSON.stringify({
      default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${port}` } },
    }));
    writeFileSync(join(root, dir, "src", "server.mjs"), `app.get("/a", h);\n`);
  };
  mk("standalone/svc", 9971);
  mk("mono/services/svc", 9972);
  const { code, out } = run(["map", root, "--json", "--no-execute"]);
  assert.equal(code, 0, out);
  const m = JSON.parse(out);
  assert.equal(m.summary.services, 2, "different advertised ports are different services");
  const names = m.services.map((s) => s.name);
  assert.notEqual(names[0], names[1], `both render as '${names[0]}' — nothing can attribute an edge`);
});

test("map --text prints the footprint and retains its model for view", () => {
  const root = corpusLike();
  const { code, out } = run(["map", root, "--text", "--no-execute"]);
  assert.equal(code, 0, out);
  assert.match(out, /gateway/);
  assert.match(out, /→\s*identity/);
  assert.ok(existsSync(join(root, `${LAYOUT.evidence}/view/records/map.json`)));
  assert.ok(!existsSync(join(root, "evidence/view/index.html")));
  assert.ok(!out.includes("<!doctype"), "text mode is for the terminal, not a file");
});

test("a tree with no APIs is a named error, never a crash", () => {
  const empty = mkdtempSync(join(tmpdir(), "map-empty-"));
  const { code, out } = run(["map", empty]);
  assert.equal(code, 1);
  const err = JSON.parse(out);   // a stack trace would fail to parse
  assert.equal(err.error.code, "NO_API_FOUND");
  assert.ok(err.error.next, "the error says what the tool looked for");
});

// --- the consumer-only repo -------------------------------------------------
//
// The first repo a stranger points this at is very often one that SERVES no
// API and only CALLS them: a frontend, a worker, a CLI. It has no OpenAPI
// document and no framework routes, so findSurfaces returns nothing — and the
// day-one promise ("every API under a tree, internal AND external") used to
// come back as NO_API_FOUND, in a repo whose footprint is four third-party
// dependencies nobody has inventoried. That is the wrong answer to the right
// question, and it is the first thing a newcomer sees.
//
// Nothing new is detected here: upstreamUrls already finds these, the model
// already carries `external`, and this only fires when there are ZERO surfaces
// — so no repo that HAS an API can have its map changed by it.

// A repo that only calls APIs: no spec, no routes, three third-party hosts.
function consumerRepo() {
  const dir = mkdtempSync(join(tmpdir(), "map-consumer-"));
  mkdirSync(join(dir, "src", "hooks"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "storefront" }));
  writeFileSync(join(dir, "src", "hooks", "useWeather.js"),
    'const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${q}`);\n');
  writeFileSync(join(dir, "src", "billing.js"),
    'await fetch("https://api.stripe.com/v1/charges", { method: "POST" });\n' +
    'await fetch("https://api.stripe.com/v1/customers");\n');
  writeFileSync(join(dir, "src", "auth.js"),
    'const AUTH = process.env.AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";\n');
  // The two shapes of URL that are NOT a dependency, both present in every
  // real repo: a lockfile full of registry hosts, and a doc link in a comment.
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
    packages: { "node_modules/x": { resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
      funding: "https://opencollective.com/x" } },
  }));
  writeFileSync(join(dir, "vite.config.js"),
    "// see https://vite.dev/config/ for the options\n" +
    "#  https://docs.example.com/setup\n" +
    "export default {};\n");
  // A service logging its OWN listen URL, with the port interpolated. The scan
  // cannot see the port, so it must not pretend to know it.
  writeFileSync(join(dir, "src", "boot.js"),
    "console.log(`listening on http://127.0.0.1:${info.port}`);\n");
  return dir;
}

test("a repo that only CALLS APIs still gets a footprint, not NO_API_FOUND", () => {
  const dir = consumerRepo();
  const { code, out } = run(["map", dir, "--json", "--no-execute"]);
  assert.equal(code, 0, `a consumer-only repo is not an error:\n${out}`);
  const m = JSON.parse(out);
  assert.equal(m.summary.services, 0, "it serves nothing, and the map says so");
  const hosts = m.external.map((e) => e.host).sort();
  assert.deepEqual(hosts, ["accounts.google.com", "api.openweathermap.org", "api.stripe.com"],
    "every third-party host the source names is on the map, each once");
});

test("the consumer map names the FILE that calls each upstream, not a service", () => {
  // With no services there is no service name to attribute a call to, and
  // "something in this repo calls Stripe" is not actionable. The caller is the
  // file, which is where a human goes to look.
  const dir = consumerRepo();
  const { out } = run(["map", dir, "--json", "--no-execute"]);
  const stripe = JSON.parse(out).external.find((e) => e.host === "api.stripe.com");
  assert.deepEqual(stripe.callers, ["src/billing.js"], `callers were ${JSON.stringify(stripe.callers)}`);
});

test("--text on a consumer-only repo reads as a dependency list, with next steps", () => {
  const dir = consumerRepo();
  const { code, out } = run(["map", dir, "--text", "--no-execute"]);
  assert.equal(code, 0, out);
  assert.match(out, /api\.stripe\.com/);
  assert.match(out, /src\/billing\.js/, "the caller file is printed, not just the host");
  assert.ok(!/\bNO_API_FOUND\b/.test(out));
});

test("a tree with neither an API nor an outbound call keeps the named error, with a next step", () => {
  // The genuinely empty case must still be an error — a footprint of nothing
  // rendered as a happy artifact is how a broken --path argument goes unnoticed.
  const empty = mkdtempSync(join(tmpdir(), "map-nothing-"));
  writeFileSync(join(empty, "README.md"), "# nothing here\n");
  const { code, out } = run(["map", empty]);
  assert.equal(code, 1);
  const err = JSON.parse(out).error;
  assert.equal(err.code, "NO_API_FOUND");
  assert.match(err.next, /calls/i, "the error says outbound calls were looked for too");
});

test("a lockfile's registry hosts and a comment's doc links are not dependencies", () => {
  // The precision half of the consumer map. Its whole content is the external
  // list, so one bogus row ("registry.npmjs.org", from a lockfile with 237 of
  // them) is the row a reader notices, and it costs the artifact its
  // credibility. Both exclusions are structural rather than a host blocklist:
  // a lockfile is not source, and a URL on a comment line is documentation.
  const dir = consumerRepo();
  const { out } = run(["map", dir, "--json", "--no-execute"]);
  const hosts = JSON.parse(out).external.map((e) => e.host);
  for (const noise of ["registry.npmjs.org", "opencollective.com", "vite.dev", "docs.example.com"])
    assert.ok(!hosts.includes(noise), `${noise} is on the map; it is not an API this repo calls: ${hosts}`);
  assert.ok(hosts.includes("api.stripe.com"), "the real dependencies survived the filter");
});

test("a URL whose port is interpolated is not reported under the default port", () => {
  // `http://127.0.0.1:${info.port}` — the port is a runtime value. The URL
  // pattern stops at the `:`, leaving a bare host that resolves to port 80,
  // so a service logging its own listen line appeared on its own map as a
  // separate upstream it calls (seen on the corpus: `127.0.0.1:80`, from
  // src/server.mjs's startup log). Everything downstream keys on host:port,
  // so a guessed port is not a small inaccuracy: it invents a node.
  const dir = consumerRepo();
  const { out } = run(["map", dir, "--json", "--no-execute"]);
  const hosts = JSON.parse(out).external.map((e) => e.host);
  assert.ok(!hosts.includes("127.0.0.1"), `an interpolated port was reported as :80 — ${hosts}`);
});

test("a real call on a line that opens with a flag is not read as a comment", () => {
  // The comment filter is a precision device and every marker it recognises is
  // paid for in recall. `--` is a comment in SQL and Lua, neither of which this
  // scan reads (py|ts|js|mjs|tsx|jsx|rb|go|yaml|toml|env|json) — so its only
  // effect on a real repo is on lines that OPEN with a long flag, which is what
  // a wrapped shell-out looks like:
  //
  //     curl -sS \
  //       --url https://api.vendor.com/v1/things
  //
  // Dropping that hides a real outbound dependency, which is the failure the
  // whole filter is written to avoid.
  const dir = consumerRepo();
  writeFileSync(join(dir, "src", "shellout.js"),
    "export const cmd = `curl -sS \\\n  --url https://api.shelled-out.com/v1/things`;\n");
  const { out } = run(["map", dir, "--json", "--no-execute"]);
  const hosts = JSON.parse(out).external.map((e) => e.host);
  assert.ok(hosts.includes("api.shelled-out.com"),
    `a wrapped shell-out was filtered as a comment: ${hosts}`);
});

// --- the consumer-only repo, one command over -------------------------------
//
// map and doctor were both fixed for the repo that serves nothing; audit was
// not, and audit is the command the quickstart names one line later ("the same
// intelligence as a report"). 12 of 26 real repos in one personal tree are
// this shape, so for half of them the documented next step was exit 1.

test("audit on a consumer-only repo reports the footprint instead of failing", () => {
  const dir = consumerRepo();
  const { code, out } = run(["audit", dir, "--no-execute"]);
  assert.equal(code, 0, `a consumer-only repo is not an audit failure:\n${out}`);
  assert.ok(!/NO_API_FOUND/.test(out), `audit refused a repo map renders happily:\n${out}`);
  assert.match(out, /api\.stripe\.com/, "the external dependency is not in the report");
  assert.match(out, /src\/billing\.js/, "the file that owns the call is not named");
});

test("audit --json on a consumer-only repo carries the same external list as map", () => {
  const dir = consumerRepo();
  const a = JSON.parse(run(["audit", dir, "--json", "--no-execute"]).out);
  const m = JSON.parse(run(["map", dir, "--json", "--no-execute"]).out);
  assert.deepEqual(a.surfaces, [], "it serves nothing, and the report says so");
  assert.deepEqual([...new Set(a.external.map((e) => new URL(e.url).host))].sort(),
    m.external.map((e) => e.host).sort(),
    "audit and map disagree about the same repo's external dependencies");
});

test("audit on a tree with neither an API nor an outbound call still names the error", () => {
  const empty = mkdtempSync(join(tmpdir(), "audit-nothing-"));
  writeFileSync(join(empty, "README.md"), "# nothing here\n");
  const { code, out } = run(["audit", empty]);
  assert.equal(code, 1);
  const err = JSON.parse(out).error;
  assert.equal(err.code, "NO_API_FOUND");
  assert.match(err.next, /calls/i, "the error still claims it only looked for served APIs");
});
