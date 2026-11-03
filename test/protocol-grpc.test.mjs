// Native gRPC over ephemeral loopback sockets. No live service is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ephemeralTlsPair } from "./helpers/ephemeral-tls.mjs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { GRPC_LIMITS, prepareGrpc } from "../lib/protocols/grpc.mjs";

const TLS_PAIR = ephemeralTlsPair();
const TYPES = `syntax = "proto3";
package fixture;
enum Kind { UNKNOWN = 0; KNOWN = 1; }
message Input { string text = 1; int32 count = 2; bytes blob = 3; int64 big = 4; Kind kind = 5; Input nested = 6; }
message Output { string text = 1; int32 count = 2; bytes blob = 3; int64 big = 4; Kind kind = 5; }
`;
const PROTO = `syntax = "proto3";
package fixture;
import "types.proto";
service Service {
  rpc Unary(Input) returns (Output);
  rpc ServerStream(Input) returns (stream Output);
  rpc ClientStream(stream Input) returns (Output);
  rpc Bidi(stream Input) returns (stream Output);
  rpc Fail(Input) returns (Output);
  rpc Slow(Input) returns (Output);
  rpc ErrorStream(Input) returns (stream Output);
  rpc Oversized(Input) returns (Output);
  rpc Early(stream Input) returns (Output);
}
`;
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sannr-grpc-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "service.proto"), PROTO);
  writeFileSync(join(root, "types.proto"), TYPES);
  return root;
}
const spec = (method = "Unary", extra = {}) => ({ grpc: {
  proto: "service.proto", service: "fixture.Service", method, ...extra,
} });
async function fixture(t, { tls = false } = {}) {
  const root = scratch(t);
  const definition = protoLoader.loadSync(join(root, "service.proto"), {
    keepCase: true, longs: String, enums: String, bytes: String,
  });
  const server = new grpc.Server(), calls = [], cancelled = [], active = new Set();
  const record = (method, call) => {
    calls.push({ method, metadata: call.metadata.getMap(), messages: [] });
    const row = calls.at(-1);
    active.add(call);
    call.on("cancelled", () => { cancelled.push(method); active.delete(call); });
    return row;
  };
  server.addService(definition["fixture.Service"], {
    Unary(call, callback) { record("Unary", call).messages.push(call.request); callback(null, call.request); },
    ServerStream(call) {
      record("ServerStream", call).messages.push(call.request);
      for (let i = 0; i < (call.request.count || 3); i += 1) call.write({ count: i, text: "row" });
      call.end();
    },
    ClientStream(call, callback) {
      const row = record("ClientStream", call);
      call.on("data", (message) => row.messages.push(message));
      call.on("end", () => callback(null, { count: row.messages.length, text: row.messages.map((m) => m.text).join(",") }));
    },
    Bidi(call) {
      const row = record("Bidi", call);
      call.on("data", (message) => { row.messages.push(message); call.write(message); });
      call.on("end", () => call.end());
    },
    Fail(call, callback) {
      record("Fail", call);
      callback({ code: grpc.status.PERMISSION_DENIED, details: "private-server-detail-fixture-secret" });
    },
    Slow(call) { record("Slow", call); },
    ErrorStream(call) {
      record("ErrorStream", call);
      call.write({ text: "retained" });
      setTimeout(() => call.emit("error", { code: grpc.status.UNAVAILABLE, details: "private-stream-detail-fixture-secret" }), 20);
    },
    Oversized(call, callback) { record("Oversized", call); callback(null, { text: "x".repeat(GRPC_LIMITS.messageBytes + 1) }); },
    Early(call, callback) {
      const row = record("Early", call);
      call.once("data", (message) => { row.messages.push(message); callback(null, { text: "early" }); });
    },
  });
  const credential = tls ? grpc.ServerCredentials.createSsl(null, [TLS_PAIR]) : grpc.ServerCredentials.createInsecure();
  const port = await new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0", credential,
    (error, port) => error ? reject(error) : resolve(port)));
  t.after(() => server.forceShutdown());
  const url = new URL(`${tls ? "https" : "http"}://127.0.0.1:${port}`);
  return { root, calls, cancelled, url };
}
async function run(f, request = spec(), extra = {}) {
  const prepared = await prepareGrpc(request, { root: f.root });
  let attempts = 0;
  const result = await prepared.execute({ url: f.url, onAttempt: () => { attempts += 1; }, ...extra });
  return { prepared, result, attempts };
}

test("unary dispatch uses the proto descriptor, sends metadata, and waits for terminal gRPC success", async (t) => {
  const f = await fixture(t);
  const body = { text: "hello", count: 2, blob: "AQID", big: "9223372036854775807", kind: "KNOWN" };
  const { prepared, result, attempts } = await run(f, spec("Unary", { body }), { headers: { authorization: "Bearer fixture-private-key", "trace-id": "fixture" } });
  assert.equal(prepared.operation, "GRPC /fixture.Service/Unary");
  assert.equal(prepared.effect, "unknown");
  assert.match(prepared.contractDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(prepared.declaration.reflection, false);
  assert.deepEqual(result, { status: null, ok: true, body, outcome: "success", complete: true,
    sent: 1, received: 1, protocolStatus: grpc.status.OK });
  assert.equal(attempts, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].metadata.authorization, "Bearer fixture-private-key");
  assert.doesNotMatch(JSON.stringify({ prepared, result }), /fixture-private-key/);
});

test("server, client, and bidirectional streams retain bounded messages and terminal success", async (t) => {
  for (const method of ["ServerStream", "ClientStream", "Bidi"]) await t.test(method, async (t) => {
    const f = await fixture(t), messages = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const request = method === "ServerStream" ? spec(method, { body: { count: 3 } }) : spec(method, { messages });
    const { result, attempts } = await run(f, request);
    assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.protocolStatus, 0);
    assert.equal(attempts, 1); assert.equal(f.calls.length, 1);
    assert.equal(result.sent, method === "ServerStream" ? 1 : 3);
    assert.equal(result.received, method === "ClientStream" ? 1 : 3);
    assert.deepEqual(result.body, method === "ServerStream" ? [{ count: 0, text: "row" }, { count: 1, text: "row" }, { count: 2, text: "row" }]
      : method === "ClientStream" ? { text: "a,b,c", count: 3 } : messages);
  });
});

test("exact stream caps can succeed while an extra message proves an incomplete collection", async (t) => {
  const f = await fixture(t);
  const exact = (await run(f, spec("ServerStream", { body: { count: 2 }, max_messages: 2 }))).result;
  assert.equal(exact.ok, true); assert.equal(exact.complete, true); assert.equal(exact.received, 2);
  const overflow = (await run(f, spec("ServerStream", { body: { count: 8 }, max_messages: 2 }))).result;
  assert.equal(overflow.ok, false); assert.equal(overflow.complete, false); assert.equal(overflow.outcome, "partial");
  assert.equal(overflow.body.length, 2); assert.equal(overflow.received, 3);
  assert.equal(overflow.error.code, "GRPC_MESSAGE_LIMIT");
  assert.ok(overflow.omissions.length);
});

test("nonzero terminal statuses preserve partial responses without returning server error details or retrying", async (t) => {
  const f = await fixture(t);
  const fail = await run(f, spec("Fail"));
  assert.equal(fail.result.ok, false); assert.equal(fail.result.complete, false);
  assert.equal(fail.result.protocolStatus, grpc.status.PERMISSION_DENIED);
  assert.equal(fail.result.error.code, "GRPC_STATUS_ERROR"); assert.equal(fail.attempts, 1);
  const partial = await run(f, spec("ErrorStream"));
  assert.equal(partial.result.ok, false); assert.equal(partial.result.complete, false);
  assert.equal(partial.result.outcome, "partial"); assert.equal(partial.result.protocolStatus, grpc.status.UNAVAILABLE);
  assert.deepEqual(partial.result.body, [{ text: "retained" }]); assert.equal(partial.attempts, 1);
  assert.doesNotMatch(JSON.stringify([fail.result, partial.result]), /private-.*detail|fixture-secret/);
  assert.deepEqual(f.calls.map((c) => c.method), ["Fail", "ErrorStream"]);
});

test("caller cancellation and configured deadlines stop pending RPCs without successful results", async (t) => {
  const f = await fixture(t);
  const before = new AbortController(); before.abort();
  const stopped = await run(f, spec(), { signal: before.signal });
  assert.equal(stopped.attempts, 0); assert.equal(stopped.result.outcome, "cancelled"); assert.equal(f.calls.length, 0);
  const during = new AbortController();
  const task = run(f, spec("Slow"), { signal: during.signal });
  const timer = setTimeout(() => during.abort(), 50);
  const cancelled = await task; clearTimeout(timer);
  assert.equal(cancelled.result.outcome, "cancelled"); assert.equal(cancelled.result.complete, false);
  const timed = await run(f, { ...spec("Slow"), timeout_ms: 40 });
  assert.equal(timed.result.outcome, "timeout"); assert.equal(timed.result.complete, false);
  assert.equal(timed.result.error.code, "GRPC_TIMEOUT"); assert.equal(timed.attempts, 1);
  const outer = await run(f, spec("Slow"), { signal: AbortSignal.timeout(40) });
  assert.equal(outer.result.outcome, "timeout"); assert.equal(outer.result.complete, false);
});

test("a response beyond the transport limit returns a nonzero terminal status", async (t) => {
  const f = await fixture(t);
  const { result, attempts } = await run(f, spec("Oversized"));
  assert.equal(result.ok, false); assert.equal(result.complete, false);
  assert.equal(result.protocolStatus, grpc.status.RESOURCE_EXHAUSTED);
  assert.equal(result.body, null); assert.equal(attempts, 1);
});

test("sent counts locally submitted messages and does not claim the server consumed every message", async (t) => {
  const f = await fixture(t);
  const messages = Array.from({ length: 8 }, () => ({ text: "x".repeat(100000) }));
  const { prepared, result, attempts } = await run(f, { ...spec("Early", { messages }), timeout_ms: 1000 });
  assert.equal(attempts, 1);
  assert.deepEqual(result.body, { text: "early" });
  assert.equal(f.calls[0].messages.length, 1);
  assert.ok(result.sent >= f.calls[0].messages.length && result.sent <= messages.length);
  if (result.complete) assert.equal(result.sent, messages.length);
  else assert.equal(result.error.code, "GRPC_SEND_INCOMPLETE");
  assert.match(prepared.declaration.sentMeaning, /local gRPC transport; delivery is not acknowledged/);
});

test("HTTPS keeps TLS verification enabled and rejects a self-signed loopback certificate", async (t) => {
  const f = await fixture(t, { tls: true });
  const { result, attempts } = await run(f, { ...spec(), timeout_ms: 500 });
  assert.equal(result.ok, false); assert.equal(result.complete, false);
  assert.equal(result.protocolStatus, grpc.status.UNAVAILABLE);
  assert.equal(result.error.code, "GRPC_STATUS_ERROR"); assert.equal(attempts, 1);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /BEGIN CERTIFICATE|self.signed|certificate/i);
});

test("unsafe targets and malformed metadata are rejected before dispatch", async (t) => {
  const root = scratch(t), prepared = await prepareGrpc(spec(), { root });
  for (const options of [
    { url: new URL("file:///fixture") }, { url: new URL("https://name:secret@localhost/") },
    { url: new URL("http://localhost/?credential=secret") },
    { url: new URL("http://localhost/tenant-prefix") },
    { url: new URL("http://localhost/"), headers: { authorization: "secret\nvalue" } },
    { url: new URL("http://localhost/"), headers: { "grpc-timeout": "1H" } },
    { url: new URL("http://localhost/"), headers: { "thing-bin": "not base64" } },
  ]) {
    let attempts = 0;
    const result = await prepared.execute({ onAttempt: () => { attempts += 1; }, ...options });
    assert.equal(attempts, 0); assert.equal(result.ok, false); assert.equal(result.sent, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test("descriptor imports are bounded, never follow symlinks or escape the project, and produce fixed errors", async (t) => {
  for (const scenario of ["outside", "absolute", "symlink-file", "symlink-dir", "oversized", "deep", "cycle", "missing", "invalid"]) await t.test(scenario, async (t) => {
    const root = scratch(t), outside = scratch(t);
    if (scenario === "outside") writeFileSync(join(root, "service.proto"), 'syntax="proto3"; import "../private-secret.proto";');
    if (scenario === "absolute") writeFileSync(join(root, "service.proto"), `syntax="proto3"; import "${join(outside, "types.proto")}";`);
    if (scenario === "symlink-file") { rmSync(join(root, "types.proto")); symlinkSync(join(outside, "types.proto"), join(root, "types.proto")); }
    if (scenario === "symlink-dir") { symlinkSync(outside, join(root, "external")); writeFileSync(join(root, "service.proto"), 'syntax="proto3"; import "external/types.proto";'); }
    if (scenario === "oversized") writeFileSync(join(root, "types.proto"), " ".repeat(GRPC_LIMITS.fileBytes + 1));
    if (scenario === "deep") {
      for (let n = 0; n <= GRPC_LIMITS.importDepth + 1; n += 1)
        writeFileSync(join(root, `d${n}.proto`), `syntax="proto3"; ${n <= GRPC_LIMITS.importDepth ? `import "d${n + 1}.proto";` : ""}`);
      writeFileSync(join(root, "service.proto"), 'syntax="proto3"; import "d0.proto";');
    }
    if (scenario === "cycle") writeFileSync(join(root, "types.proto"), 'syntax="proto3"; import "service.proto";');
    if (scenario === "missing") rmSync(join(root, "types.proto"));
    if (scenario === "invalid") writeFileSync(join(root, "types.proto"), "private-secret-invalid-proto");
    await assert.rejects(prepareGrpc(spec(), { root }), (error) => {
      assert.equal(error.code, "GRPC_DESCRIPTOR_INVALID");
      assert.doesNotMatch(error.message, /private-secret|sannr-grpc-|types.proto/);
      return true;
    });
  });
});

test("preparation enforces declared request types, message budgets, stream shapes, and deadlines", async (t) => {
  const root = scratch(t);
  const bad = [
    spec("Unknown"), spec("Unary", { body: { invented: true } }), spec("Unary", { body: { count: "not a number" } }),
    spec("Unary", { body: { count: 2147483648 } }), spec("Unary", { body: { big: "9223372036854775808" } }),
    spec("Unary", { body: { blob: "!invalid" } }), spec("Unary", { body: { kind: "NOT_DECLARED" } }),
    spec("Unary", { body: { text: "x".repeat(GRPC_LIMITS.messageBytes + 1) } }),
    spec("Unary", { messages: [] }), spec("ClientStream", { body: {} }),
    spec("ClientStream", { messages: Array.from({ length: GRPC_LIMITS.maxMessages + 1 }, () => ({})), max_messages: GRPC_LIMITS.maxMessages }),
    spec("ServerStream", { max_messages: 0 }), spec("ServerStream", { max_messages: 101 }),
    { ...spec(), timeout_ms: 0 }, { ...spec(), timeout_ms: 300001 },
  ];
  let deep = {};
  for (let n = 0; n < GRPC_LIMITS.depth + 2; n += 1) deep = { nested: deep };
  bad.push(spec("Unary", { body: deep }));
  for (const request of bad) await assert.rejects(prepareGrpc(request, { root }), (error) => {
    assert.match(error.code, /^GRPC_(DESCRIPTOR_INVALID|MESSAGE_INVALID|MESSAGE_LIMIT|REQUEST_INVALID)$/);
    return true;
  });
});

test("descriptor digests include imports and prepared calls hold immutable descriptor and message snapshots", async (t) => {
  const f = await fixture(t), request = spec("Unary", { body: { text: "before" } });
  const prepared = await prepareGrpc(request, { root: f.root });
  const same = await prepareGrpc(request, { root: f.root });
  assert.equal(prepared.contractDigest, same.contractDigest);
  writeFileSync(join(f.root, "types.proto"), TYPES + "\n// a different descriptor revision\n");
  const changed = await prepareGrpc(request, { root: f.root });
  assert.notEqual(prepared.contractDigest, changed.contractDigest);
  request.grpc.body.text = "after";
  rmSync(join(f.root, "types.proto"));
  const result = await prepared.execute({ url: f.url });
  assert.deepEqual(result.body, { text: "before" });
  assert.equal(result.ok, true);
});
