import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyMissing } from "./stress.mjs";

test("stress harness retries an external stub host, then degrades with exit 0", () => {
  const firstRequest = "GET /first";
  const droppedRequest = "GET /second";
  const decision = classifyMissing({
    base: "https://stub.example",
    local: false,
    missing: [droppedRequest],
    retryMissing: [droppedRequest],
  });
  assert.deepEqual(decision.violations, []);
  assert.equal(decision.degraded.reason, "no response after retry");
  assert.equal(decision.exitCode, 0);
  assert.notEqual(firstRequest, droppedRequest, "stub covers an answered first request and dropped second request");
});

test("stress harness keeps a dropped fixture request as a violation with exit 1", () => {
  const decision = classifyMissing({
    base: "http://fixture.stub",
    local: true,
    missing: ["GET /dropped"],
    retryMissing: [],
  });
  assert.equal(decision.degraded, null);
  assert.equal(decision.violations[0].why, "no response");
  assert.equal(decision.exitCode, 1);
});
