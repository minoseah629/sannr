import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostmanClient, scrubEnvironmentShape, scrubCaptured } from "../lib/postman.mjs";

const fake = (responses, calls) => async (url, init) => {
  calls.push({ url, init });
  const next = responses.shift() ?? { status: 200, body: "{}" };
  return { status: next.status, ok: next.status >= 200 && next.status < 300,
    text: async () => next.body };
};

test("Postman client exposes only allowlisted GET operations", async () => {
  const calls = [];
  process.env.POSTMAN_API_KEY = "fixture-key";
  const c = createPostmanClient({ fetchImpl: fake([{ status: 200, body: '{"id":"me"}' }], calls) });
  assert.deepEqual(await c.me, { id: "me" });
  assert.equal(c.get, undefined, "raw get surface would permit non-GET paths");
  assert.equal(c.post, undefined, "POST cannot be expressed through the client surface");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["X-Api-Key"], "fixture-key");
  assert.throws(() => c.workspace("../write"), { code: "POSTMAN_PATH_REFUSED" });
  delete process.env.POSTMAN_API_KEY;
});

test("literal API keys are refused and missing env keys do not leak", () => {
  delete process.env.POSTMAN_API_KEY;
  assert.throws(() => createPostmanClient({ apiKey: "literal" }), { code: "POSTMAN_API_KEY_LITERAL_REFUSED" });
  assert.throws(() => createPostmanClient({ fetchImpl: async () => {} }), { code: "POSTMAN_API_KEY_MISSING" });
});

test("429 and empty bodies retry within a bounded call budget", async () => {
  process.env.POSTMAN_API_KEY = "fixture-key";
  const calls = [], waits = [];
  const c = createPostmanClient({ retries: 2, budget: 3, sleep: async (ms) => waits.push(ms),
    fetchImpl: fake([{ status: 429, body: "busy" }, { status: 200, body: "" }, { status: 200, body: '{"ok":true}' }], calls) });
  assert.deepEqual(await c.me, { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [250, 500]);
  delete process.env.POSTMAN_API_KEY;
});

test("environment shape keeps names/types/enabled and drops every value", () => {
  const env = scrubEnvironmentShape({ id: "e1", name: "local", values: [
    { key: "baseUrl", value: "https://example.test", type: "default", enabled: true },
    { key: "openai-key", value: "sk-live-NOT-REAL", type: "secret", enabled: true },
  ] });
  assert.deepEqual(env.values, [
    { key: "baseUrl", type: "default", enabled: true },
    { key: "openai-key", type: "secret", enabled: true },
  ]);
  assert.equal(JSON.stringify(env).includes("https://example.test"), false);
  assert.equal(JSON.stringify(env).includes("sk-live-NOT-REAL"), false);
});

test("capture scrub scans non-environment strings and reports redactions", () => {
  const out = scrubCaptured({ collections: [{ info: { name: "safe", description: "sk-live-NOT-REAL" } }], environments: [] });
  assert.equal(JSON.stringify(out).includes("sk-live-NOT-REAL"), false);
  assert.equal(out.redactions.redactions, 1);
});
