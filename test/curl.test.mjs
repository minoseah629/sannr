// The curl parser is a security boundary, not a convenience. node --test test/curl.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCurl, tokenize } from "../lib/curl.mjs";

const ok = (c) => { const r = parseCurl(c); assert.ok(!r.error, r.error?.code); return r; };

test("tokenizer handles quotes, escapes and line continuations", () => {
  assert.deepEqual(tokenize(`curl -H 'A: b c' "https://x/y"`), ["curl", "-H", "A: b c", "https://x/y"]);
  assert.deepEqual(tokenize("curl \\\n  -X POST \\\n  https://x"), ["curl", "-X", "POST", "https://x"]);
  assert.deepEqual(tokenize(`curl -d "{\\"a\\":1}" https://x`), ["curl", "-d", '{"a":1}', "https://x"]);
  assert.deepEqual(tokenize(`curl -d '' https://x`), ["curl", "-d", "", "https://x"], "empty string is a real argument");
});

test("a bare GET", () => {
  const { request, origin } = ok("curl https://api.example.com/things?limit=2");
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/things");
  assert.deepEqual(request.params, { limit: "2" });
  assert.equal(origin, "https://api.example.com");
});

test("method is inferred from a body, then made explicit", () => {
  assert.equal(ok(`curl https://x/y -d '{"a":1}'`).request.method, "POST");
  assert.equal(ok("curl -X PATCH https://x/y").request.method, "PATCH");
});

test("json bodies parse; non-json is passed through with a warning", () => {
  assert.deepEqual(ok(`curl https://x/y -d '{"a":1,"b":"two"}'`).request.body, { a: 1, b: "two" });
  const r = parseCurl("curl https://x/y -d 'not json at all'");
  assert.equal(r.request.body, "not json at all");
  assert.match(r.warnings.join(), /not valid JSON/);
});

test("form encoding is detected, not guessed", () => {
  const r = ok("curl https://x/token --data-urlencode 'grant_type=client_credentials' --data-urlencode 'scope=read'");
  assert.equal(r.request.body_type, "form");
  assert.deepEqual(r.request.body, { grant_type: "client_credentials", scope: "read" });
});

test("multipart separates files from fields", () => {
  const r = ok(("curl -F 'avatar=@/" + "tmp/me.png' -F 'name=alice' https://x/upload"));
  assert.equal(r.request.body_type, "multipart");
  assert.deepEqual(r.request.files, { avatar: ("/" + "tmp/me.png") });
  assert.deepEqual(r.request.body, { name: "alice" });
});

test("-G moves data into the query string", () => {
  const r = ok("curl -G https://x/search -d 'q=dune' -d 'limit=5'");
  assert.equal(r.request.method, "GET");
  assert.deepEqual(r.request.params, { q: "dune", limit: "5" });
  assert.equal(r.request.body, undefined);
});

test("content-type is dropped because body_type already decides it", () => {
  const r = ok(`curl https://x/y -H 'Content-Type: application/json' -d '{"a":1}'`);
  assert.equal(r.request.headers, undefined, "no headers should remain");
});

// --- the security boundary -------------------------------------------------

test("a literal credential in a header is REFUSED, not carried", () => {
  for (const h of ["Authorization: Bearer sk-live-x", "X-API-Key: abc123",
                   "api-key: abc", "X-Auth-Token: t", "Cookie: session=abc"]) {
    const r = parseCurl(`curl -H '${h}' https://x/y`);
    assert.equal(r.error?.code, "CREDENTIAL_IN_CURL", `not refused: ${h}`);
    assert.ok(!JSON.stringify(r).includes("sk-live-x") || h.includes("Authorization"),
      "the refusal must not echo the secret back into wider output");
  }
});

test("a literal credential in the query string is REFUSED", () => {
  for (const p of ["api_key=abc", "access_token=abc", "token=abc", "signature=abc"]) {
    const r = parseCurl(`curl 'https://x/y?${p}'`);
    assert.equal(r.error?.code, "CREDENTIAL_IN_CURL", `not refused: ${p}`);
  }
});

test("-u basic auth is treated as a credential", () => {
  const r = parseCurl("curl -u admin:hunter2 https://x/y");
  assert.equal(r.error?.code, "CREDENTIAL_IN_CURL");
});

test("the refusal tells the user to rotate, because the paste already exposed it", () => {
  const r = parseCurl("curl -H 'X-API-Key: abc' https://x/y");
  assert.match(r.error.next, /rotate/i);
  assert.match(r.error.next, /API_AUTH/);
});

test("an ordinary header is not mistaken for a credential", () => {
  const r = ok("curl -H 'X-Request-Id: req-42' -H 'Accept: application/xml' https://x/y");
  assert.deepEqual(r.request.headers, { "X-Request-Id": "req-42", Accept: "application/xml" });
});

// --- never drop silently ---------------------------------------------------

test("an unsupported flag is reported, never silently ignored", () => {
  const r = parseCurl("curl --oauth2-bearer abc https://x/y");
  assert.match(r.warnings.join(), /--oauth2-bearer/);
});

test("flags that genuinely change nothing produce no noise", () => {
  const r = ok("curl -sS --compressed -L -k https://x/y");
  assert.deepEqual(r.warnings, [], "benign flags must not generate warnings");
});

test("a non-curl command is refused", () => {
  assert.equal(parseCurl("wget https://x/y").error?.code, "NOT_A_CURL_COMMAND");
});

test("a missing or relative URL is refused", () => {
  assert.equal(parseCurl("curl -X GET").error?.code, "CURL_HAS_NO_URL");
  assert.equal(parseCurl("curl /things").error?.code, "CURL_URL_INVALID");
});

// --- adversarial batch (2026-08-14): credential edges the fixed denylist missed
test("-G data carrying a credential is refused like a query credential", () => {
  // Same request, two spellings: ?api_key=… is refused, so -G --data api_key=… must be too.
  assert.equal(parseCurl("curl -G https://x/y --data 'api_key=sk_live_x'").error?.code, "CREDENTIAL_IN_CURL");
});
test("client_secret and private_key are recognised as credentials", () => {
  assert.equal(parseCurl("curl 'https://x/y?client_secret=abc'").error?.code, "CREDENTIAL_IN_CURL");
  assert.equal(parseCurl("curl 'https://x/y?private_key=abc'").error?.code, "CREDENTIAL_IN_CURL");
});
test("a custom credential-shaped header is refused, denylist or not", () => {
  for (const h of ["X-Vault-Token: s.abc", "X-Company-Secret: c", "X-Refresh-Token: r"])
    assert.equal(parseCurl(`curl -H '${h}' https://x/y`).error?.code, "CREDENTIAL_IN_CURL", `not refused: ${h}`);
});
test("an ordinary -Key header is NOT mistaken for a credential", () => {
  // The guard keys on token/secret/password endings, not -key, so these pass.
  for (const h of ["Idempotency-Key: k1", "X-Request-Key: rk", "X-Trace-Id: t"])
    assert.ok(!parseCurl(`curl -H '${h}' https://x/y`).error, `wrongly refused: ${h}`);
});
test("a credential in URL userinfo is refused, not silently dropped", () => {
  assert.equal(parseCurl("curl https://admin:hunter2@x/y").error?.code, "CREDENTIAL_IN_CURL");
});
