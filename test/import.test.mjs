// `sannr import` — Postman v2.1 → suites, with an honest loss report.
//
//   node --test test/import.test.mjs
//
// The deliverable is the REPORT, so most tests here are about honesty under
// loss: secrets counted and never copied, untranslatable scripts counted and
// never approximated, assertion-less steps quarantined in the todo file
// rather than imported silently green. Determinism is pinned because a
// migration you can diff is a migration you can review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { importPostman, importBruno, importInsomnia, importPostmanV3,
         resolveVars, envValues, sourceDrift, renderImportReport, stableStringify, importBrunoDirectory } from "../lib/import.mjs";
import { normalizeSuite } from "../lib/suites.mjs";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The upstream corpus lives outside the repository; a sibling-free checkout (CI) skips by name.
const corpusSkip = existsSync(join(process.cwd(), "..", "import-corpus")) ? false
  : "sibling corpus ../import-corpus absent — local yardstick, run where it exists";
import { parseYaml } from "../lib/yaml.mjs";

// A fixture with every hazard the importer must survive: folders, {{vars}},
// secret headers and params, a bearer token, translatable and untranslatable
// tests, a prerequest script, a saved example, a non-JSON body, and one
// request with nothing to assert from at all.
const SECRET = "sk-live-FIXTURE-NOT-REAL";
const collection = {
  info: { name: "Fleet Ops", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: `{{authToken}}` }] },
  variable: [{ key: "version", value: "v2" }],
  item: [
    { name: "Vehicles", item: [
      { name: "List vehicles",
        request: { method: "GET",
          url: { raw: "{{baseUrl}}/{{version}}/vehicles?limit=10&api_key={{apiKey}}",
                 query: [{ key: "limit", value: "10" }, { key: "api_key", value: `{{apiKey}}` }] },
          header: [{ key: "Accept", value: "application/json" },
                   { key: "Authorization", value: `Bearer ${SECRET}` }] },
        event: [{ listen: "test", script: { exec: [
          'pm.test("status ok", function () {',
          "  const jsonData = pm.response.json();",
          "  pm.response.to.have.status(200);",
          '  pm.expect(jsonData.data[0].status).to.eql("active");',
          "});" ] } }] },
      { name: "Create vehicle",
        request: { method: "POST",
          url: { raw: "{{baseUrl}}/{{version}}/vehicles" },
          body: { mode: "raw", raw: '{"vin": "123", "fleet": "west"}' } },
        event: [
          { listen: "prerequest", script: { exec: ["pm.environment.set('ts', Date.now())"] } },
          { listen: "test", script: { exec: [
            'pm.test("created", () => {',
            "  pm.response.to.have.status(201);",
            "  pm.collectionVariables.set('vehicleId', pm.response.json().id);",   // untranslatable
            "});" ] } }] },
    ] },
    { name: "Health",
      request: { method: "GET", url: { raw: "{{baseUrl}}/health" } },
      response: [{ name: "ok", code: 200 }] },                       // example → derived status
    { name: "Mystery",
      request: { method: "GET", url: { raw: "{{baseUrl}}/mystery" } } }, // nothing to assert from
    { name: "Unresolved",
      request: { method: "GET", url: { raw: "{{baseUrl}}/tenants/{{tenantId}}/report" } },
      response: [{ name: "ok", code: 200 }] },                       // has example BUT unresolved var
  ],
};

const run = (opts = {}) => importPostman(structuredClone(collection),
  { sourceText: JSON.stringify(collection), ...opts });

test("Postman import produces a runnable v2 suite and an honest, secret-free disposition for every source item", () => {
  const { suite, todo, report, provenance, name } = run();
  assert.equal(suite.v, 2);
  const everything = stableStringify({ suite, todo, report, provenance });
  assert.ok(!everything.includes(SECRET), "a literal bearer token crossed the import");
  assert.ok(!everything.includes("apiKey}}") || !/api_key=/.test(stableStringify(suite)),
    "secret-shaped query param survived into the suite");
  assert.ok(report.counts.secrets_omitted_by_design >= 2,
    "the Authorization header and api_key param must both be counted as omitted");
  const list = todo.find((s) => s.id === "vehicles/list-vehicles");
  assert.ok(list, "omitted credentials quarantine the request while preserving its assertions");
  assert.deepEqual(list.expect.find((e) => "status" in e), { status: 200 });
  assert.deepEqual(list.expect.find((e) => e.json === "data.0.status"),
    { json: "data.0.status", equals: "active" });
  const create = suite.requests.find((s) => s.id === "vehicles/create-vehicle");
  assert.deepEqual(create.expect, [{ status: 201 }],
    "only the provable statement translates; the collectionVariables.set line must not");
  assert.ok(report.counts.scripts_needing_manual_conversion >= 2,
    "the prerequest script and the partially-translated test are both manual work");
  assert.ok(!suite.requests.some((s) => s.id === "mystery"), "mystery must not be runnable");
  const t = todo.find((s) => s.id === "mystery");
  assert.ok(t && /no assertion/i.test(t.todo));
  const health = suite.requests.find((s) => s.id === "health");
  assert.deepEqual(health.expect, [{ status: 200 }]);
  assert.equal(report.counts.assertions_derived_from_examples, 1);
  const norm = normalizeSuite(name, suite);
  assert.ok(!norm.problems?.length,
    `imported suite must be directly runnable: ${stableStringify(norm.problems ?? [])}`);
  const text = renderImportReport(report);
  assert.match(text, /imported/);
  assert.match(text, /secret\(s\) omitted by design/);
  assert.match(text, /bearer:POSTMAN_BEARER_TOKEN/);
  assert.ok(!text.includes(SECRET));
});

test("unresolved variables send the step to todo naming the variable — even when an example exists", () => {
  const { todo } = run();
  const t = todo.find((s) => s.id === "unresolved");
  assert.ok(t, "step with {{tenantId}} unresolved must be quarantined");
  assert.match(t.todo, /tenantId/);
  const withValues = run({ values: { tenantId: "t-42" } });
  const now = withValues.suite.requests.find((s) => s.id === "unresolved");
  assert.ok(now, "--values declares a runtime input without committing its value");
  assert.equal(now.path, "/tenants/{tenantId}/report");
  assert.ok(!stableStringify(withValues).includes("t-42"));
});

test("a translated assertion is retained in todo beside an unresolved body input", () => {
  const out = importPostman({ info: { name: "Liberal" }, item: [{
    name: "embed", request: { method: "POST", url: "/v1/embeddings", body: { mode: "raw", raw: '{"input":"{{textString}}"}' } },
    event: [{ listen: "test", script: { exec: ['pm.response.to.have.status(200);', 'pm.expect(pm.response.json()).to.have.property("data");'] } }],
  }] });
  assert.equal(out.suite.requests.length, 0);
  assert.deepEqual(out.todo[0].assertion_provenance, ["translated", "translated"]);
  assert.equal(out.todo.length, 1);
});

test("collection variables resolve; {{baseUrl}} hoists; secret-shaped values never inline", () => {
  const { text } = resolveVars("{{baseUrl}}/{{version}}/x", { version: "v2" });
  assert.equal(text, "/v2/x");
  const s = resolveVars("Bearer {{authToken}}", { authToken: "oops" });
  assert.ok(s.text.includes("{{authToken}}") && s.secrets.includes("authToken"),
    "a secret-shaped variable must stay a reference even when its value is known");
  assert.deepEqual(envValues({ values: [{ key: "a", value: "1" }, { key: "b", value: "2", enabled: false }] }),
    { a: "1" });
});

test("deterministic: same source, byte-identical output", () => {
  const a = run(), b = run();
  assert.equal(stableStringify(a.suite), stableStringify(b.suite));
  assert.equal(renderImportReport(a.report), renderImportReport(b.report));
});

test("re-import drift: changed and added items are named; same source is recognized", () => {
  const a = run();
  const mutated = structuredClone(collection);
  mutated.item[1].request.url.raw = "{{baseUrl}}/healthz";         // change Health
  mutated.item.push({ name: "New thing", request: { method: "GET", url: { raw: "{{baseUrl}}/new" } },
    response: [{ name: "ok", code: 204 }] });
  const b = importPostman(mutated, { sourceText: JSON.stringify(mutated) });
  const drift = sourceDrift(a.provenance, b.provenance);
  assert.equal(drift.same_source, false);
  assert.ok(drift.changed.includes("health"));
  assert.ok(drift.added.includes("new-thing"));
  const same = sourceDrift(a.provenance, run().provenance);
  assert.equal(same.same_source, true);
  assert.deepEqual(same.changed, []);
});

test("Bruno .bru imports request blocks, query/body/assertions, and quarantines scripts", () => {
  const source = `meta {
  name: Bruno orders
  type: http
  seq: 1
}

post {
  url: https://api.example.test/orders
  body: json
  auth: none
}

headers {
  Content-Type: application/json
  Authorization: Bearer sk-live-FIXTURE-NOT-REAL
}

params:query {
  dry_run: true
}

body:json {
  {"sku":"redacted","quantity":1,"token":"sk-live-FIXTURE-NOT-REAL"}
}

assert {
  res.status: eq 201
}

script:post-response {
  console.log("manual");
}`;
  const out = importBruno(source, { sourceName: "orders.bru", sourceText: source });
  const encoded = stableStringify(out);
  assert.ok(!encoded.includes("sk-live-FIXTURE-NOT-REAL"));
  assert.equal(out.name, "bruno-orders");
  assert.equal(out.suite.requests.length, 0);
  assert.deepEqual(out.todo[0].expect, [{ status: 201 }]);
  assert.deepEqual(out.todo[0].params, { dry_run: "true" });
  assert.deepEqual(out.todo[0].body, { sku: "redacted", quantity: 1 });
  assert.equal(out.report.counts.secrets_omitted_by_design, 2);
  assert.ok(out.report.counts.scripts_needing_manual_conversion >= 1);
});

test("Bruno collection skips metadata files, composes folder headers, and orders by seq", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-bruno-"));
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "bruno.json"), JSON.stringify({ name: "fixture", proxy: { config: { hostname: "{{proxyHost}}", auth: { username: "proxy-user-fixture", password: "proxy-password-fixture" } } } }));
  writeFileSync(join(root, "collection.bru"), "headers {\n  X-Collection: yes\n}\nauth {\n  mode: bearer\n}\nvars:secret [\n  collectionSecret\n]\n");
  writeFileSync(join(root, "folder", "folder.bru"), "meta {\n name: folder\n}\nheaders {\n  X-Folder: yes\n}\n");
  writeFileSync(join(root, "environments.bogus"), "ignored");
  mkdirSync(join(root, "environments"));
  writeFileSync(join(root, "environments", "Local.bru"), "vars {\n  host: https://env-value-must-not-cross.test\n}\n");
  writeFileSync(join(root, "folder", "late.bru"), "meta {\n name: Late\n seq: 2\n}\nget {\n url: /late\n}\nassert {\n res.status: eq 200\n}\n");
  writeFileSync(join(root, "first.bru"), "meta {\n name: First\n seq: 1\n}\nget {\n url: /first\n}\nassert {\n res.status: eq 200\n}\n");
  const out = importBrunoDirectory(root);
  assert.deepEqual(out.suite.requests.map((x) => x.id), ["first", "folder/late"]);
  assert.equal(out.suite.requests[1].headers["X-Collection"], "yes");
  assert.equal(out.suite.requests[1].headers["X-Folder"], "yes");
  assert.deepEqual(out.environmentFacts, [{ name: "Local", vars: ["host"], secrets: [] }]);
  const encoded = stableStringify({ suite: out.suite, todo: out.todo, report: out.report });
  assert.ok(!encoded.includes("proxy-user-fixture") && !encoded.includes("proxy-password-fixture"));
  assert.deepEqual(out.report.proxy, { configured: true, hostname: "proxyHost" });
  assert.ok(out.report.loss.some((x) => x.name === "collection.bru:vars:secret") === false);
});

test("Bruno declarative assertions preserve repeated keys and Chai mechanical subset", () => {
  const out = importBruno(`meta {\n name: assertions\n seq: 1\n}\nget {\n url: /x\n}\nassert {\n res.status: eq 200\n res.body.count: gt 1\n res.body.name: neq nope\n res.body.tags: isArray\n res.body.missing: isUndefined\n res.body.message: contains hello\n}\ntests {\n test("named", () => { expect(body.name).to.equal("ok"); });\n}`);
  const all = stableStringify(out);
  assert.ok(all.includes('"gt": 1') && all.includes('"not_equals": "nope"') && all.includes('"exists": false'));
  assert.ok(out.construct_ledger.some((entry) => entry.name === "named"), "authored test labels stay attributed in the construct ledger");
  assert.ok(out.report.loss.some((entry) => entry.name === "named"), "an undeclared body alias is named unsupported");
});

test("R1-H Bruno declarative headers translate and response time is reported-only", () => {
  const out = importBruno(`meta {\n name: headers\n}\nget {\n url: /x\n}\nassert {\n res.headers.content-type: eq application/json\n res.headers["x-request-id"]: isDefined\n res.responseTime: lt 500\n req.url: eq /x\n someVar: eq value\n}`);
  assert.deepEqual(out.suite.requests[0].expect, [
    { header: "content-type", equals: "application/json" },
    { header: "x-request-id", exists: true },
  ]);
  assert.ok(out.report.loss.some((x) => x.reason === "Bruno response-time comparison is reported-only"));
  assert.ok(out.report.loss.some((x) => x.name.startsWith("req.url")));
  assert.ok(out.report.loss.some((x) => x.name.startsWith("someVar")));
});

test("Bruno tests translate what they can and quarantine unsupported statements by test name", () => {
  const out = importBruno(`meta {\n name: mixed\n}\nget {\n url: /x\n}\ntests {\n test("mix", function () { expect(res.status).to.equal(200); for (const x of []) {} });\n}`);
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 200 }]);
  assert.ok(out.report.counts.scripts_quarantined.some((q) => q.script.endsWith(":mix") && /loop/i.test(q.reason)));
});

test("Bruno getter response facts and the Chai mechanical subset translate", () => {
  const out = importBruno(`meta {\n name: getters\n}\nget {\n url: /x\n}\ntests {\n test("status", function () { expect(res.getStatus()).to.equal(200); });\n test("body", function () { expect(res.getBody().id).to.eql(1); });\n test("header", function () { expect(res.getHeader("Content-Type")).to.include("json"); });\n test("forms", function () { expect(res.body.ok).to.be.true; expect(res.body.n).to.be.above(1); expect(res.body.s).to.match(/^ok/); });\n}`);
  assert.deepEqual(out.suite.requests[0].expect, [
    { status: 200 }, { json: "id", equals: 1 },
    { header: "content-type", matches: "^.*json.*$" },
    { json: "ok", equals: true }, { json: "n", gt: 1 }, { json: "s", matches: "^ok" },
  ]);
});

test("Bruno todo entries explain why they are not in the suite", () => {
  const out = importBruno(`meta {\n name: todo-note\n}\nget {\n url: /x\n}`);
  assert.match(out.todo[0].notes, /no assert block and no tests block/);
  assert.equal(out.report.items.find((item) => item.id === out.todo[0].id).notes.at(-1), out.todo[0].notes);
});

test("Bruno environment facts promote variable and secret names only", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-bruno-env-"));
  mkdirSync(join(root, "environments"));
  writeFileSync(join(root, "environments", "local.bru"), "vars {\n base: https://env-value\n token: token-value\n}\nvars:secret [\n api_key\n]\n");
  writeFileSync(join(root, "request.bru"), "meta {\n name: request\n}\nget {\n url: /x\n}\nassert {\n res.status: eq 200\n}\n");
  const out = importBrunoDirectory(root);
  assert.deepEqual(out.environmentFacts, [{ name: "local", vars: ["base", "token"], secrets: ["api_key"] }]);
  const encoded = stableStringify(out);
  assert.ok(encoded.includes("api_key") && !encoded.includes("token-value") && !encoded.includes("https://env-value"));
});

test("Bruno upstream corpus imports with a pinned loss shape and no environment values", { skip: corpusSkip }, () => {
  const corpus = join(process.cwd(), "..", "import-corpus", "bruno", "usebruno-bruno-tests");
  const out = importBrunoDirectory(corpus);
  const encoded = stableStringify({ suite: out.suite, todo: out.todo, report: out.report });
  for (const value of ["your_secret_token", "envVar1", "collection_pre_var_value", "anoop"]) {
    if (value !== "proxyHostname") assert.ok(!encoded.includes(value), `environment/proxy value crossed: ${value}`);
  }
  // IMPORT-POLICY-1: owner accepts 92 runnable requests. The 26
  // historical losses are own body limits (17), undeclared templates (3),
  // absent faithful response assertions (3), and own auth conflicts/limits (3).
  // Inherited setup is retained once per owner, not multiplied or silently run.
  // Exact assertion grammar remains at the pre-policy 226; no count inflation.
  assert.deepEqual({ imported: out.report.counts.imported, todo: out.report.counts.todo, translated: out.report.counts.translated, quarantined: out.report.counts.quarantined }, { imported: 92, todo: 131, translated: 226, quarantined: 1643 });
  assert.deepEqual(out.report.environmentFacts, [
    { name: "Local", vars: ["host", "localhost", "httpfaker", "bearer_auth_token", "basic_auth_password", "env.var1", "env-var2", "bark", "foo", "testSetEnvVar", "echo-host", "client_id", "client_secret", "auth_url", "callback_url", "access_token_url", "passwordCredentials_username", "passwordCredentials_password", "github_authorize_url", "github_access_token_url", "google_auth_url", "google_access_token_url", "google_scope", "typed_env_num", "typed_env_bool", "typed_env_obj"], secrets: ["github_client_secret", "github_client_id", "google_client_id", "google_client_secret", "github_authorization_code", "passwordCredentials_access_token", "client_credentials_access_token", "authorization_code_access_token", "github_access_token"] },
    { name: "Prod", vars: ["host", "localhost", "httpfaker", "bearer_auth_token", "basic_auth_password", "env.var1", "env-var2", "bark", "foo", "testSetEnvVar", "echo-host", "typed_env_num", "typed_env_bool", "typed_env_obj"], secrets: [] },
  ]);
  assert.deepEqual([...new Set(out.report.loss.map((x) => x.reason))].sort(), [
    "Bruno assertion is outside the declarative/mechanical grammar",
    "call or assignment outside the Bruno test grammar",
    "conditional, exception or loop execution is outside the Bruno test grammar",
    "contains has no exact suite operator across JSON strings and arrays; not approximated as a regex",
    "docs is quarantined; never executed during import",
    "docs is quarantined; scripts are never executed during import",
    "eql() requires one fully consumed supported literal argument; compound expressions and unsupported literals are not translated",
    "equal() requires one fully consumed supported literal argument; compound expressions and unsupported literals are not translated",
    "include() has no exact suite operator on a json target; not approximated",
    "params:path is quarantined; scripts are never executed during import",
    "query is quarantined; scripts are never executed during import",
    "script:post-response is quarantined; scripts are never executed during import",
    "script:pre-request is quarantined; never executed during import",
    "script:pre-request is quarantined; scripts are never executed during import",
    "settings is quarantined; scripts are never executed during import",
    "tests is quarantined; never executed during import",
    "truthiness has no exact suite operator; not approximated as boolean equality",
    "unparsed assertion statement is outside the Bruno mechanical grammar",
    "vars:pre-request is quarantined; scripts are never executed during import",
  ]);
});

test("Insomnia v4 imports folders, environment references, responses, and auth without values", () => {
  const exported = {
    _type: "export", __export_format: 4,
    resources: [
      { _id: "wrk_1", _type: "workspace", name: "Payments" },
      { _id: "fld_1", _type: "request_group", parentId: "wrk_1", name: "Orders" },
      { _id: "env_1", _type: "environment", data: { base_url: "https://api.example.test" } },
      { _id: "req_1", _type: "request", parentId: "fld_1", name: "List orders",
        method: "GET", url: "https://api.example.test/orders?limit=10",
        headers: [{ name: "Accept", value: "application/json" },
          { name: "Authorization", value: "Bearer sk-live-FIXTURE-NOT-REAL" }],
        parameters: [{ name: "limit", value: "10" }],
        authentication: { type: "bearer", token: "sk-live-FIXTURE-NOT-REAL" } },
      { _id: "res_1", _type: "response", parentId: "req_1", statusCode: 200 },
    ],
  };
  const out = importInsomnia(exported, { sourceText: JSON.stringify(exported) });
  const encoded = stableStringify(out);
  assert.ok(!encoded.includes("sk-live-FIXTURE-NOT-REAL"));
  assert.equal(out.name, "payments");
  assert.equal(out.suite.requests.length, 1);
  assert.equal(out.suite.requests[0].id, "orders/list-orders");
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 200 }]);
  assert.equal(out.report.environment.auth, "bearer:POSTMAN_BEARER_TOKEN");
  assert.ok(out.report.counts.secrets_omitted_by_design >= 1);
});

test("Postman v3 YAML uses the same loss-report and mandatory-assertion contract", () => {
  const yaml = `info:
  name: YAML collection
  schema: https://schema.getpostman.com/json/collection/v3.0.0/collection.json
item:
  - name: Health
    request:
      method: GET
      url: https://api.example.test/health
    response:
      - code: 204
  - name: Mystery
    request:
      method: GET
      url: https://api.example.test/mystery
`;
  const out = importPostmanV3(yaml, { sourceText: yaml });
  assert.equal(out.provenance.source_kind, "postman-v3");
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 204 }]);
  assert.equal(out.todo[0].id, "mystery");
  assert.match(out.todo[0].todo, /no assertion/i);
  assert.throws(() => importPostmanV3("info:\n  name: broken\n"), /no collection items/);
});

test("Insomnia v5 YAML imports the collection tree, composes folder policy, and quarantines named scripts", () => {
  const source = {
    type: "collection.insomnia.rest/5.0", name: "V5 Fixture", environments: [{ name: "Dev", data: { token: "SECRET" } }],
    collection: [{ name: "Folder", headers: [{ name: "X-Folder", value: "ok" }],
      authentication: { type: "bearer", token: "SECRET" },
      scripts: { preRequest: "never run" }, children: [{ name: "Request", meta: { id: "req_1" }, method: "GET", url: "https://api.example.test/x",
        headers: [{ name: "X-Request", value: "yes" }], scripts: { afterResponse: "never run" }, responses: [{ statusCode: 201 }] }] }],
  };
  const out = importInsomnia(source, { sourceText: stableStringify(source) });
  assert.deepEqual(out.suite.requests[0].headers, { "X-Folder": "ok", "X-Request": "yes" });
  assert.equal(out.suite.requests[0].auth, "bearer:POSTMAN_BEARER_TOKEN");
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 201 }]);
  assert.deepEqual(out.suite.requests[0].assertion_provenance, ["inferred"]);
  assert.deepEqual(out.report.counts.scripts_quarantined.filter((x) => x.script.includes(":script:")).map((x) => x.script).sort(), ["folder/request:script:afterResponse", "root/Folder:script:preRequest:script:preRequest"]);
  assert.equal(out.provenance.source_kind, "insomnia-v5");
  assert.deepEqual(out.report.environment.names, ["Dev"]);
  assert.ok(!stableStringify(out).includes("SECRET"));
});

test("Insomnia refusals are coded and typed", () => {
  assert.throws(() => importInsomnia({ type: "mcpClient.insomnia/5.0" }), (error) =>
    error.code === "INSOMNIA_UNSUPPORTED_DOCUMENT" && error.documentType === "mcpClient.insomnia/5.0" && /mcpClient/.test(error.message));
  assert.throws(() => importInsomnia({ type: "not-insomnia/1.0" }), (error) =>
    error.code === "INSOMNIA_UNSUPPORTED_DOCUMENT" && !error.documentType && /document.type/.test(error.message) && !/not-insomnia/.test(error.message));
  assert.throws(() => importInsomnia({}), (error) =>
    error.code === "INSOMNIA_DOCUMENT_UNRECOGNIZED" && !error.documentType && /v4 export resources or v5 collection/.test(error.message));
});

test("Insomnia environment documents import names only, including sub-environments", () => {
  const source = { type: "environment.insomnia.rest/5.0", name: "Workspace", environments: {
    name: "Dev", data: { base_url: "http://localhost:8000", auth_token: "fixture-secret", inherited_value: "from-global" },
    subEnvironments: [{ name: "Child", data: { child_url: "https://child.example", child_token: "child-secret" } }],
  } };
  const out = importInsomnia(source);
  assert.deepEqual(out.suite, { v: 2, requests: [] });
  assert.deepEqual(out.todo, []);
  assert.deepEqual(out.environmentFacts, [
    { name: "Dev", vars: ["base_url", "auth_token", "inherited_value"], secrets: ["auth_token"] },
    { name: "Child", vars: ["child_url", "child_token"], secrets: ["child_token"] },
  ]);
  assert.equal(out.report.source_kind, "insomnia-v5-environment");
  assert.ok(!stableStringify(out).includes("http://localhost:8000"));
  assert.ok(!stableStringify(out).includes("fixture-secret"));
  assert.ok(!stableStringify(out).includes("from-global"));
});

test("Insomnia spec documents walk their collection tree and name the wrapped OpenAPI contract", () => {
  const source = { type: "spec.insomnia.rest/5.0", name: "Spec", collection: [{ name: "Folder", children: [{ name: "Request", meta: { id: "req_spec" }, method: "GET", url: "https://api.example.test/x", responses: [{ statusCode: 200 }] }] }], spec: { contents: { openapi: "3.0.4", info: { title: "Wrapped API" } } } };
  const out = importInsomnia(source);
  assert.equal(out.report.source_kind, "insomnia-v5-spec");
  assert.equal(out.report.counts.items, 1);
  assert.equal(out.report.counts.imported, 1);
  assert.deepEqual(out.report.wrapped_spec, { kind: "openapi", version: "3.0.4", title: "Wrapped API" });
});

test("Insomnia v5 corpus pins every document outcome and never emits environment values", { skip: corpusSkip }, () => {
  const root = join(process.cwd(), "..", "import-corpus", "insomnia", "kong-insomnia-v5-roundtrip");
  // These request exports remain assertionless/manual. Changes from the old pins
  // name undeclared templates, sensitive body omissions and unsupported own
  // auth; inherited script declarations have one loss per owner. Baggage's
  // +12 is 17 newly named template losses minus 5 duplicate script losses.
  const expected = {
    "baggage.yaml": { counts: [15, 0, 15, 33], source: "insomnia-v5-spec", wrapped: ["3.0.4", "Insomnia Airlines — Baggage API"] },
    "bookings.yaml": { counts: [15, 0, 15, 31], source: "insomnia-v5-spec", wrapped: ["3.0.4", "Insomnia Airlines — Bookings API"] },
    "collection_runner.yaml": { counts: [10, 0, 10, 20], source: "insomnia-v5" },
    "dev_environment.yaml": { env: [{ name: "Dev", vars: ["base_url", "auth_token", "inherited_value"], secrets: ["auth_token"] }], source: "insomnia-v5-environment" },
    "flights.yaml": { counts: [14, 0, 14, 25], source: "insomnia-v5-spec", wrapped: ["3.0.4", "Insomnia Airlines — Flights & Airports API"] },
    "imported_collection.yaml": { counts: [2, 0, 2, 0], source: "insomnia-v5" },
    "linting_bookings.yaml": { counts: [0, 0, 0, 0], source: "insomnia-v5-spec", wrapped: ["3.0.4", "Insomnia Airlines — Bookings API"] },
    "mcp_flights.yaml": { refused: "INSOMNIA_UNSUPPORTED_DOCUMENT" },
    "operations.yaml": { counts: [14, 0, 14, 14], source: "insomnia-v5" },
    "production_environment.yaml": { env: [{ name: "Production", vars: ["base_url"], secrets: [] }], source: "insomnia-v5-environment" },
    "security.yaml": { refused: "INSOMNIA_DOCUMENT_UNRECOGNIZED" },
    "security_collection.yaml": { counts: [6, 0, 6, 16], source: "insomnia-v5-spec", wrapped: ["3.0.4", "Insomnia Airlines — Security & Testing API"] },
    "staging_environment.yaml": { env: [{ name: "Staging", vars: ["base_url"], secrets: [] }], source: "insomnia-v5-environment" },
    "variable_inheritance.yaml": { counts: [1, 0, 1, 3], source: "insomnia-v5" },
  };
  for (const file of readdirSync(root).filter((x) => x.endsWith(".yaml")).sort()) {
    const text = readFileSync(join(root, file), "utf8");
    const doc = parseYaml(text);
    const pin = expected[file];
    if (pin.refused) {
      assert.throws(() => importInsomnia(doc, { sourceText: text }), (error) => error.code === pin.refused);
      continue;
    }
    const out = importInsomnia(doc, { sourceText: text });
    if (pin.env) assert.deepEqual(out.environmentFacts, pin.env, file);
    else assert.deepEqual([out.report.counts.items, out.report.counts.imported, out.report.counts.todo, out.report.counts.scripts_quarantined.length], pin.counts, file);
    assert.equal(out.report.source_kind, pin.source, file);
    if (pin.wrapped) assert.deepEqual([out.report.wrapped_spec.version, out.report.wrapped_spec.title], pin.wrapped, file);
    const encoded = stableStringify({ suite: out.suite, todo: out.todo, report: out.report });
    assert.ok(!/e1015e6d-039b-42dd-b038-31068702935d|from_global_env|from-folder/.test(encoded), `${file}: environment value crossed`);
    assert.equal(out.report.counts.assertions_translated, 0, `${file}: Insomnia tautologies are not response assertions`);
  }
});
